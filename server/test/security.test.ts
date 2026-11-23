import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Authenticator } from "./authenticator";
import { addMember, api, firmRow, login } from "./helpers";
import { PENDING, SESSION, addPasskey, codeStep, pendingOptions, pendingVerify, secondStep } from "./passkey-flow";

const MEMBER = "member@firm.test";

const policy = (cookie: string, on: unknown) => api("/api/security/policy", { method: "PUT", cookie, body: { require_passkeys: on } });
const me = async (cookie: string) => (await api("/api/me", { cookie })).status;
const rows = async (sql: string, ...binds: unknown[]) => (await env.CONTROL.prepare(sql).bind(...binds).all<any>()).results;
const actions = async () => (await env.DB_NA.prepare("SELECT action, meta FROM audit WHERE action LIKE 'passkey.%' OR action LIKE 'security.%' ORDER BY at, id").all<any>()).results;
const userId = async (email: string) => (await rows("SELECT id FROM users WHERE email = ?", email))[0].id as string;

// an owner with a passkey and a member without one
async function account() {
  const owner = await login();
  const ownerKey = await Authenticator.create();
  await addPasskey(owner, ownerKey);
  const member = await addMember(owner);
  return { owner, ownerKey, member };
}

describe("requiring passkeys", () => {
  it("is switched on by an owner who has a passkey", async () => {
    const { owner } = await account();
    expect((await policy(owner, true)).status).toBe(200);
    expect((await firmRow(owner)).require_passkeys).toBe(1);
    expect((await (await api("/api/passkeys", { cookie: owner })).json<any>()).required).toBe(true);
    expect((await actions()).find((a) => a.action === "security.require_passkeys").meta).toBe('{"on":true}');
    expect((await policy(owner, false)).status).toBe(200);
    expect((await firmRow(owner)).require_passkeys).toBe(0);
  });

  it("is refused for an owner with no passkey", async () => {
    const owner = await login();
    const res = await policy(owner, true);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "passkey_needed" });
    expect((await firmRow(owner)).require_passkeys).toBe(0);
  });

  it("is not for members, and rejects a value that is not true or false", async () => {
    const { owner, member } = await account();
    expect((await policy(member, true)).status).toBe(403);
    expect((await api("/api/security/policy", { cookie: member })).status).toBe(403);
    expect((await policy(owner, "yes")).status).toBe(400);
    expect((await firmRow(owner)).require_passkeys).toBe(0);
  });

  it("never reaches another account", async () => {
    const { owner } = await account();
    const other = await login("other@firm.test");
    await addPasskey(other, await Authenticator.create());
    await policy(owner, true);
    expect((await firmRow(other)).require_passkeys).toBe(0);
    expect((await (await api("/api/security/policy", { cookie: other })).json<any>()).without).toEqual([]);
    expect((await api("/api/security/policy")).status).toBe(401);
  });

  it("lists who has no passkey yet", async () => {
    const { owner } = await account();
    const seen = await (await api("/api/security/policy", { cookie: owner })).json<any>();
    expect(seen.require_passkeys).toBe(false);
    expect(seen.without.map((u: any) => u.email)).toEqual([MEMBER]);
    const people = (await (await api("/api/staff", { cookie: owner })).json<any>()).people;
    expect(people.map((p: any) => [p.email, p.passkeys])).toEqual([["owner@firm.test", 1], [MEMBER, 0]]);
  });

  it("does not end sessions that are already open", async () => {
    const { owner, member } = await account();
    await policy(owner, true);
    expect(await me(member)).toBe(200);
    expect(await me(owner)).toBe(200);
  });

  it("shows in the Activity feed", async () => {
    const { owner } = await account();
    await policy(owner, true);
    const feed = await (await api("/api/activity", { cookie: owner })).json<any>();
    expect(feed.rows.map((r: any) => r.action)).toEqual(expect.arrayContaining(["security.require_passkeys", "passkey.add"]));
  });

  it("refuses to remove the last passkey while it is required, but not the others", async () => {
    const { owner, member } = await account();
    await addPasskey(member, await Authenticator.create());
    await policy(owner, true);
    const mine = (await (await api("/api/passkeys", { cookie: owner })).json<any>()).passkeys[0].id;
    const res = await api(`/api/passkeys/${mine}`, { method: "DELETE", cookie: owner });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "last_passkey" });
    await addPasskey(owner, await Authenticator.create());
    expect((await api(`/api/passkeys/${mine}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    // switched off, the last one can go
    await policy(owner, false);
    const left = (await (await api("/api/passkeys", { cookie: owner })).json<any>()).passkeys[0].id;
    expect((await api(`/api/passkeys/${left}`, { method: "DELETE", cookie: owner })).status).toBe(200);
  });
});

describe("enrolment at sign-in", () => {
  it("asks a member without a passkey to add one before the session starts", async () => {
    const { owner } = await account();
    await policy(owner, true);
    const { body, cookies } = await codeStep(MEMBER);
    expect(body).toEqual({ ok: true, step: "enrol" });
    expect(cookies[SESSION]).toBeUndefined();
    const pending = cookies[PENDING];
    expect(await (await api("/api/auth/pending", { cookie: pending })).json()).toEqual({ step: "enrol", role: "member", email: MEMBER });
    expect(await me(pending)).toBe(401);
    expect((await api("/api/passkeys", { cookie: pending })).status).toBe(401);

    const { kind, options } = await (await pendingOptions(pending)).json<any>();
    expect(kind).toBe("register");
    expect(options.user.name).toBe(MEMBER);
    const key = await Authenticator.create();
    const res = await pendingVerify(pending, await key.register(options), { name: "Phone" });
    expect(res.status).toBe(200);
    const session = res.headers.getSetCookie().find((c) => c.startsWith(SESSION))!.split(";")[0];
    expect(await me(session)).toBe(200);
    expect((await rows("SELECT name, user_id FROM passkeys WHERE name = 'Phone'"))).toHaveLength(1);
    expect(await rows("SELECT 1 FROM pending_logins")).toHaveLength(0);
    expect((await actions()).filter((a) => a.action === "passkey.add")).toHaveLength(2);

    // the next time it is the passkey itself
    const next = await codeStep(MEMBER);
    expect(next.body).toEqual({ ok: true, step: "passkey" });
    expect((await secondStep(next.cookies[PENDING], key)).res.status).toBe(200);
  });

  it("makes no session when the enrolment fails, and the passkey is not kept", async () => {
    const { owner } = await account();
    await policy(owner, true);
    const pending = (await codeStep(MEMBER)).cookies[PENDING];
    const { options } = await (await pendingOptions(pending)).json<any>();
    const key = await Authenticator.create();
    expect((await pendingVerify(pending, await key.register(options, "https://evil.test"))).status).toBe(400);
    expect((await pendingVerify(pending, await key.register(options))).status).toBe(400);
    expect(await rows("SELECT 1 FROM passkeys WHERE user_id = ?", await userId(MEMBER))).toHaveLength(0);
    expect(await rows("SELECT 1 FROM sessions WHERE user_id = ?", await userId(MEMBER))).toHaveLength(1);
  });

  it("applies to an owner who has no passkey yet when a second owner turned it on", async () => {
    const { owner } = await account();
    const id = await userId(MEMBER);
    await env.CONTROL.prepare("UPDATE users SET role = 'owner' WHERE id = ?").bind(id).run();
    await policy(owner, true);
    const { body } = await codeStep(MEMBER);
    expect(body.step).toBe("enrol");
  });

  it("does not ask anyone once the setting is off again", async () => {
    const { owner } = await account();
    await policy(owner, true);
    await policy(owner, false);
    const { body, cookies } = await codeStep(MEMBER);
    expect(body).toEqual({ ok: true });
    expect(cookies[SESSION]).toBeDefined();
  });

  it("only asks the account that requires it", async () => {
    const { owner } = await account();
    await policy(owner, true);
    const { body } = await codeStep("other@firm.test");
    expect(body).toEqual({ ok: true });
  });
});

describe("owner resets a member's passkeys", () => {
  it("deletes them, ends the sessions and sends the member back to enrolment", async () => {
    const { owner, member } = await account();
    const key = await Authenticator.create();
    await addPasskey(member, key);
    await policy(owner, true);
    const id = await userId(MEMBER);
    const res = await api(`/api/staff/${id}/reset-passkeys`, { method: "POST", cookie: owner });
    expect(res.status).toBe(200);
    expect(await me(member)).toBe(401);
    expect(await me(owner)).toBe(200);
    expect(await rows("SELECT 1 FROM passkeys WHERE user_id = ?", id)).toHaveLength(0);
    const reset = (await actions()).find((a) => a.action === "passkey.reset");
    expect(JSON.parse(reset.meta)).toEqual({ count: 1 });
    expect((await codeStep(MEMBER)).body.step).toBe("enrol");
  });

  it("also clears a sign-in that was waiting for the old passkey", async () => {
    const { owner, member } = await account();
    const key = await Authenticator.create();
    await addPasskey(member, key);
    const { cookies } = await codeStep(MEMBER);
    await api(`/api/staff/${await userId(MEMBER)}/reset-passkeys`, { method: "POST", cookie: owner });
    expect((await secondStep(cookies[PENDING], key)).res.status).toBe(401);
  });

  it("is for owners, within the account, and not for oneself", async () => {
    const { owner, member } = await account();
    const stranger = await login("other@firm.test");
    const target = await userId(MEMBER);
    const self = await userId("owner@firm.test");
    expect((await api(`/api/staff/${self}/reset-passkeys`, { method: "POST", cookie: member })).status).toBe(403);
    expect((await api(`/api/staff/${target}/reset-passkeys`, { method: "POST", cookie: stranger })).status).toBe(404);
    expect((await api(`/api/staff/${self}/reset-passkeys`, { method: "POST", cookie: owner })).status).toBe(409);
    expect((await api(`/api/staff/${"0".repeat(32)}/reset-passkeys`, { method: "POST", cookie: owner })).status).toBe(404);
    expect(await rows("SELECT 1 FROM passkeys")).toHaveLength(1);
    expect(await me(member)).toBe(200);
  });

  it("is dropped with the person when they are removed", async () => {
    const { owner, member } = await account();
    await addPasskey(member, await Authenticator.create());
    expect((await api(`/api/staff/${await userId(MEMBER)}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect(await rows("SELECT 1 FROM passkeys")).toHaveLength(1);
  });
});
