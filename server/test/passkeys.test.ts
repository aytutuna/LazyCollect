import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Authenticator } from "./authenticator";
import { addMember, api, login } from "./helpers";
import { PENDING, SESSION, addPasskey, codeStep, pendingOptions, pendingVerify, secondStep } from "./passkey-flow";

const OWNER = "owner@firm.test";

const list = async (cookie: string) => (await api("/api/passkeys", { cookie })).json<any>();
const me = async (cookie: string) => (await api("/api/me", { cookie })).status;
const rows = async (sql: string, ...binds: unknown[]) => (await env.CONTROL.prepare(sql).bind(...binds).all<any>()).results;
const actions = async (like: string) => (await env.DB_NA.prepare("SELECT action FROM audit WHERE action LIKE ? ORDER BY at, id").bind(like).all<{ action: string }>()).results.map((r) => r.action);

// a user with one passkey who has just passed the email step
async function atSecondStep(email = OWNER) {
  const cookie = await login(email);
  const key = await Authenticator.create();
  expect((await addPasskey(cookie, key)).status).toBe(201);
  const { body, cookies } = await codeStep(email);
  return { cookie, key, body, pending: cookies[PENDING], cookies };
}

describe("adding and removing passkeys", () => {
  it("registers a passkey and lists it without key material", async () => {
    const cookie = await login();
    const key = await Authenticator.create();
    const res = await addPasskey(cookie, key, "Work laptop");
    expect(res.status).toBe(201);
    const seen = await list(cookie);
    expect(seen.required).toBe(false);
    expect(seen.passkeys).toHaveLength(1);
    expect(seen.passkeys[0]).toMatchObject({ name: "Work laptop", user_verified: true, last_used_at: null });
    expect(JSON.stringify(seen)).not.toContain(key.credentialId);
    const stored = (await rows("SELECT * FROM passkeys"))[0];
    expect(stored.credential_id).toBe(key.credentialId);
    expect(stored.counter).toBe(0);
    expect(JSON.parse(stored.transports)).toEqual(["internal"]);
    expect(await actions("passkey.%")).toEqual(["passkey.add"]);
  });

  it("records when the authenticator did not verify the user", async () => {
    const cookie = await login();
    await addPasskey(cookie, await Authenticator.create(false));
    expect((await list(cookie)).passkeys[0].user_verified).toBe(false);
  });

  it("names a passkey after the device when no name is given, and refuses a long name", async () => {
    const cookie = await login();
    expect((await addPasskey(cookie, await Authenticator.create())).status).toBe(201);
    expect((await list(cookie)).passkeys[0].name).toBe("Unknown device");
    expect((await addPasskey(cookie, await Authenticator.create(), "x".repeat(61))).status).toBe(400);
  });

  it("refuses a challenge used a second time", async () => {
    const cookie = await login();
    const key = await Authenticator.create();
    const options = await (await api("/api/passkeys/options", { method: "POST", cookie })).json<any>();
    const response = await key.register(options);
    expect((await api("/api/passkeys", { method: "POST", cookie, body: { response } })).status).toBe(201);
    const again = await api("/api/passkeys", { method: "POST", cookie, body: { response } });
    expect(again.status).toBe(400);
    expect(await rows("SELECT 1 FROM passkeys")).toHaveLength(1);
  });

  it("refuses an expired challenge, a wrong origin and another user's challenge", async () => {
    const cookie = await login();
    const key = await Authenticator.create();
    const options = await (await api("/api/passkeys/options", { method: "POST", cookie })).json<any>();
    await env.CONTROL.prepare("UPDATE passkey_challenges SET expires_at = ?").bind(Date.now() - 1).run();
    expect((await api("/api/passkeys", { method: "POST", cookie, body: { response: await key.register(options) } })).status).toBe(400);

    const fresh = await (await api("/api/passkeys/options", { method: "POST", cookie })).json<any>();
    expect((await api("/api/passkeys", { method: "POST", cookie, body: { response: await key.register(fresh, "https://evil.test") } })).status).toBe(400);

    const other = await login("other@firm.test");
    const mine = await (await api("/api/passkeys/options", { method: "POST", cookie })).json<any>();
    expect((await api("/api/passkeys", { method: "POST", cookie: other, body: { response: await key.register(mine) } })).status).toBe(400);
    expect(await rows("SELECT 1 FROM passkeys")).toHaveLength(0);
  });

  it("refuses an authentication challenge as a registration one", async () => {
    const { pending, cookie } = await atSecondStep();
    const { options } = await (await pendingOptions(pending)).json<any>();
    const key = await Authenticator.create();
    expect((await api("/api/passkeys", { method: "POST", cookie, body: { response: await key.register(options) } })).status).toBe(400);
  });

  it("refuses a credential that is already registered, to anyone", async () => {
    const cookie = await login();
    const key = await Authenticator.create();
    await addPasskey(cookie, key);
    const other = await login("other@firm.test");
    expect((await addPasskey(other, key)).status).toBe(409);
    expect((await addPasskey(cookie, key)).status).toBe(409);
  });

  it("stops at 10 passkeys", async () => {
    const cookie = await login();
    for (let i = 0; i < 10; i++) expect((await addPasskey(cookie, await Authenticator.create())).status).toBe(201);
    expect((await addPasskey(cookie, await Authenticator.create())).status).toBe(409);
  });

  it("removes a passkey, but only one's own", async () => {
    const owner = await login();
    const member = await addMember(owner);
    await addPasskey(owner, await Authenticator.create());
    await addPasskey(member, await Authenticator.create());
    const theirs = (await list(member)).passkeys[0].id;
    const mine = (await list(owner)).passkeys[0].id;
    expect((await api(`/api/passkeys/${theirs}`, { method: "DELETE", cookie: owner })).status).toBe(404);
    const stranger = await login("other@firm.test");
    expect((await api(`/api/passkeys/${mine}`, { method: "DELETE", cookie: stranger })).status).toBe(404);
    expect((await list(member)).passkeys).toHaveLength(1);
    expect((await api(`/api/passkeys/${mine}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect((await list(owner)).passkeys).toHaveLength(0);
    expect(await actions("passkey.remove")).toHaveLength(1);
  });

  it("needs a session for every passkey route", async () => {
    for (const [method, path] of [["GET", "/api/passkeys"], ["POST", "/api/passkeys/options"], ["POST", "/api/passkeys"], ["DELETE", `/api/passkeys/${"0".repeat(32)}`]]) {
      expect((await api(path, { method })).status).toBe(401);
    }
  });
});

describe("signing in with a passkey", () => {
  it("holds the sign-in after the code and makes no session", async () => {
    const { body, cookies, pending } = await atSecondStep();
    expect(body).toEqual({ ok: true, step: "passkey" });
    expect(cookies[SESSION]).toBeUndefined();
    expect(pending).toBeDefined();
    expect(await rows("SELECT 1 FROM sessions")).toHaveLength(1);
  });

  it("does the same for the magic link", async () => {
    const owner = await login();
    await addPasskey(owner, await Authenticator.create());
    const { body, cookies } = await codeStep(OWNER, "link");
    expect(body).toEqual({ ok: true, step: "passkey" });
    expect(cookies[SESSION]).toBeUndefined();
    expect(cookies[PENDING]).toBeDefined();
  });

  it("gives nothing away on its own: the pending cookie is not a session", async () => {
    const { pending } = await atSecondStep();
    for (const path of ["/api/me", "/api/firm", "/api/clients", "/api/requests", "/api/staff", "/api/sessions", "/api/passkeys", "/api/activity"]) {
      expect((await api(path, { cookie: pending })).status).toBe(401);
    }
    expect((await api("/api/passkeys/options", { method: "POST", cookie: pending })).status).toBe(401);
    // and passing it off as the session cookie does not work either
    const token = pending.split("=")[1];
    expect((await api("/api/me", { cookie: `${SESSION}=${token}` })).status).toBe(401);
  });

  it("describes the pending step and clears it on request", async () => {
    const { pending } = await atSecondStep();
    expect(await (await api("/api/auth/pending", { cookie: pending })).json()).toEqual({ step: "passkey", role: "owner", email: OWNER });
    expect(await (await api("/api/auth/pending")).json()).toEqual({ step: null });
    expect((await api("/api/auth/pending", { method: "DELETE", cookie: pending })).status).toBe(200);
    expect(await (await api("/api/auth/pending", { cookie: pending })).json()).toEqual({ step: null });
  });

  it("makes the session only after a valid assertion, once", async () => {
    const { key, pending } = await atSecondStep();
    const { options, kind } = await (await pendingOptions(pending)).json<any>();
    expect(kind).toBe("authenticate");
    expect(options.allowCredentials).toHaveLength(1);
    const response = await key.assert(options);
    const res = await pendingVerify(pending, response);
    expect(res.status).toBe(200);
    const session = res.headers.getSetCookie().find((c) => c.startsWith(SESSION))!.split(";")[0];
    expect(await me(session)).toBe(200);
    const stored = (await rows("SELECT * FROM passkeys"))[0];
    expect(stored.counter).toBe(1);
    expect(stored.last_used_at).toBeGreaterThan(0);
    // the pending token is spent
    expect(await rows("SELECT 1 FROM pending_logins")).toHaveLength(0);
    expect((await pendingVerify(pending, response)).status).toBe(401);
    expect((await pendingOptions(pending)).status).toBe(401);
  });

  it("refuses an assertion that answers an old challenge", async () => {
    const { key, pending } = await atSecondStep();
    const { options } = await (await pendingOptions(pending)).json<any>();
    const response = await key.assert(options);
    expect((await pendingVerify(pending, response)).status).toBe(200);
    // a new sign-in; the old answer is replayed
    const next = (await codeStep(OWNER)).cookies[PENDING];
    expect((await pendingVerify(next, response)).status).toBe(400);
    expect(await rows("SELECT 1 FROM sessions")).toHaveLength(2);
  });

  it("refuses a bad signature, another key, a wrong origin and an expired challenge", async () => {
    const { key, pending } = await atSecondStep();
    const stranger = await Authenticator.create();
    const get = async () => (await (await pendingOptions(pending)).json<any>()).options;
    expect((await pendingVerify(pending, await stranger.assert(await get()))).status).toBe(400);
    expect((await pendingVerify(pending, await key.assert(await get(), { origin: "https://evil.test" }))).status).toBe(400);
    const stale = await get();
    await env.CONTROL.prepare("UPDATE passkey_challenges SET expires_at = ?").bind(Date.now() - 1).run();
    expect((await pendingVerify(pending, await key.assert(stale))).status).toBe(400);
    expect((await pendingVerify(pending, { id: "x", rawId: "x", type: "public-key", response: {} })).status).toBe(400);
    expect((await pendingVerify(pending, "nope")).status).toBe(400);
    expect(await rows("SELECT 1 FROM sessions")).toHaveLength(1);
    // the real key still works afterwards
    expect((await secondStep(pending, key)).res.status).toBe(200);
  });

  it("does not take a passkey that belongs to someone else", async () => {
    const { pending } = await atSecondStep();
    const other = await login("other@firm.test");
    const theirs = await Authenticator.create();
    await addPasskey(other, theirs);
    expect((await secondStep(pending, theirs)).res.status).toBe(400);
  });

  it("gives up after 5 wrong answers, even for the right key", async () => {
    const { key, pending } = await atSecondStep();
    const stranger = await Authenticator.create();
    for (let i = 0; i < 5; i++) expect((await secondStep(pending, stranger)).res.status).toBe(400);
    expect((await secondStep(pending, key)).res.status).toBe(401);
    expect(await rows("SELECT 1 FROM pending_logins")).toHaveLength(0);
  });

  it("lets the pending login lapse after 5 minutes", async () => {
    const { key, pending } = await atSecondStep();
    await env.CONTROL.prepare("UPDATE pending_logins SET expires_at = ?").bind(Date.now() - 1).run();
    expect((await pendingOptions(pending)).status).toBe(401);
    expect((await secondStep(pending, key)).res.status).toBe(401);
    expect(await (await api("/api/auth/pending", { cookie: pending })).json()).toEqual({ step: null });
  });

  it("cannot be used by a person who was removed meanwhile", async () => {
    const owner = await login();
    const member = await addMember(owner);
    const key = await Authenticator.create();
    await addPasskey(member, key);
    const { cookies } = await codeStep("member@firm.test");
    const id = (await rows("SELECT id FROM users WHERE email = 'member@firm.test'"))[0].id;
    expect((await api(`/api/staff/${id}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect((await secondStep(cookies[PENDING], key)).res.status).toBe(401);
    expect(await rows("SELECT 1 FROM passkeys")).toHaveLength(0);
  });

  it("refuses and logs a counter that went backwards", async () => {
    const { key, pending } = await atSecondStep();
    await env.CONTROL.prepare("UPDATE passkeys SET counter = 5").run();
    const { options } = await (await pendingOptions(pending)).json<any>();
    const res = await pendingVerify(pending, await key.assert(options, { counter: 3 }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "passkey_counter" });
    expect(res.headers.getSetCookie().some((c) => c.startsWith(SESSION))).toBe(false);
    expect((await rows("SELECT counter FROM passkeys"))[0].counter).toBe(5);
    expect(await actions("passkey.%")).toEqual(["passkey.add", "passkey.counter_refused"]);
    // the sign-in is over; the same pending cookie is no use now
    expect((await pendingOptions(pending)).status).toBe(401);
  });

  it("refuses a repeated counter, and accepts an authenticator that never counts", async () => {
    const { key, pending } = await atSecondStep();
    await env.CONTROL.prepare("UPDATE passkeys SET counter = 5").run();
    const { options } = await (await pendingOptions(pending)).json<any>();
    expect((await pendingVerify(pending, await key.assert(options, { counter: 5 }))).status).toBe(403);

    await env.CONTROL.prepare("UPDATE passkeys SET counter = 0").run();
    const next = (await codeStep(OWNER)).cookies[PENDING];
    const { options: again } = await (await pendingOptions(next)).json<any>();
    expect((await pendingVerify(next, await key.assert(again, { counter: 0 }))).status).toBe(200);
  });

  it("limits the second step like the code step", async () => {
    const { pending } = await atSecondStep();
    const ip = "198.51.100.9";
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await pendingOptions(pending, ip)).status);
    expect(statuses).toContain(429);
    const verifies = [];
    for (let i = 0; i < 12; i++) verifies.push((await api("/api/auth/pending/verify", { method: "POST", cookie: pending, ip: "198.51.100.10", body: { response: {} } })).status);
    expect(verifies).toContain(429);
  });

  it("has no pending step without a cookie", async () => {
    expect((await pendingOptions("")).status).toBe(401);
    expect((await api("/api/auth/pending/verify", { method: "POST", body: { response: {} } })).status).toBe(401);
  });

  it("goes straight in for someone with no passkey while the account does not require one", async () => {
    const { body, cookies } = await codeStep(OWNER);
    expect(body).toEqual({ ok: true });
    expect(cookies[SESSION]).toBeDefined();
    expect(cookies[PENDING]).toBeUndefined();
  });
});
