import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Authenticator } from "./authenticator";
import { addPasskey } from "./passkey-flow";
import { api, codeFrom, login, mockOutbound } from "./helpers";
import { bearer, pendingHeader, post, proof } from "./app";

const EMAIL = "owner@firm.test";

async function startCode(email = EMAIL) {
  const sent = mockOutbound();
  const res = await post("/api/app/auth/start", { email, platform: "android", attestation: await proof(email) });
  expect(res.status).toBe(200);
  return codeFrom(sent[0]);
}

async function appSignIn(email = EMAIL) {
  const code = await startCode(email);
  return post("/api/app/auth/verify", { email, code, platform: "android" });
}

describe("app challenge", () => {
  it("hands out a challenge and says which platforms are checked", async () => {
    const res = await post("/api/app/challenge", { platform: "android" });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.challenge.length).toBeGreaterThan(30);
    expect(body.required).toBe(true);
  });

  it("is unavailable for a platform with no check set up, unless it is listed in APP_ATTEST_OFF", async () => {
    expect((await post("/api/app/challenge", { platform: "ios" })).status).toBe(503);
    expect(await (await post("/api/app/challenge", { platform: "ios" })).json()).toEqual({ error: "unavailable" });
    expect((await post("/api/app/attest", { key_id: "a", challenge: "b", attestation: "c" })).status).toBe(503);
    expect((await post("/api/app/auth/start", { email: EMAIL, platform: "ios" })).status).toBe(503);
    expect((await post("/api/app/client/exchange", { token: "x", platform: "ios" })).status).toBe(503);
    env.APP_ATTEST_OFF = "ios";
    try {
      const body = await (await post("/api/app/challenge", { platform: "ios" })).json<any>();
      expect(body.required).toBe(false);
    } finally {
      env.APP_ATTEST_OFF = undefined;
    }
  });

  it("refuses an unknown platform and a request without the X-Collect header", async () => {
    expect((await post("/api/app/challenge", { platform: "windows" })).status).toBe(400);
    expect((await post("/api/app/challenge", { platform: "android" }, { "X-Collect": "0" })).status).toBe(403);
  });

  it("is rate limited", async () => {
    let last = 200;
    for (let i = 0; i < 40 && last === 200; i++) last = (await post("/api/app/challenge", { platform: "android" }, {}, "198.51.100.7")).status;
    expect(last).toBe(429);
  });
});

describe("app sign-in", () => {
  it("sends a code without Turnstile and returns a bearer token on verify", async () => {
    const res = await appSignIn();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const { ok, token } = await res.json<any>();
    expect(ok).toBe(true);
    const me = await api("/api/me", { headers: bearer(token) });
    expect((await me.json<any>()).user.email).toBe(EMAIL);
    const row = await env.CONTROL.prepare("SELECT app, label FROM sessions").first<any>();
    expect(row).toEqual({ app: "android", label: "Lazy Collect for Android" });
  });

  it("shows in the signed-in devices and ends with the session", async () => {
    const web = await login();
    const { token } = await (await appSignIn()).json<any>();
    const list = await (await api("/api/sessions", { cookie: web })).json<any[]>();
    expect(list.map((s) => s.label).sort()).toEqual(["Lazy Collect for Android", "Unknown device"]);
    const mine = await (await api("/api/sessions", { headers: bearer(token) })).json<any[]>();
    expect(mine.find((s) => s.current).label).toBe("Lazy Collect for Android");
    await api(`/api/sessions/${list.find((s) => s.label.includes("Android")).id}`, { method: "DELETE", cookie: web });
    expect((await api("/api/me", { headers: bearer(token) })).status).toBe(401);
  });

  it("refuses to start without a proof, with a proof for another address, or with a replayed one", async () => {
    const sent = mockOutbound();
    expect((await post("/api/app/auth/start", { email: EMAIL, platform: "android" })).status).toBe(400);
    expect((await post("/api/app/auth/start", { email: EMAIL, platform: "android", attestation: await proof("other@firm.test") })).status).toBe(400);
    const good = await proof(EMAIL);
    expect((await post("/api/app/auth/start", { email: EMAIL, platform: "android", attestation: good })).status).toBe(200);
    expect((await post("/api/app/auth/start", { email: EMAIL, platform: "android", attestation: good })).status).toBe(400);
    expect(sent).toHaveLength(1);
  });

  it("refuses a bad address, an unknown platform and a verify without one", async () => {
    mockOutbound();
    expect((await post("/api/app/auth/start", { email: "nope", platform: "android" })).status).toBe(400);
    expect((await post("/api/app/auth/start", { email: EMAIL, platform: "web" })).status).toBe(400);
    expect((await post("/api/app/auth/verify", { email: EMAIL, code: "123456" })).status).toBe(400);
  });

  it("takes no proof for a platform in APP_ATTEST_OFF, and still rate limits", async () => {
    const sent = mockOutbound();
    const saved = env.PLAY_INTEGRITY_SA;
    env.PLAY_INTEGRITY_SA = undefined;
    expect((await post("/api/app/auth/start", { email: EMAIL, platform: "android" })).status).toBe(503);
    env.APP_ATTEST_OFF = "android";
    try {
      expect((await post("/api/app/auth/start", { email: EMAIL, platform: "android" })).status).toBe(200);
      expect(sent).toHaveLength(1);
      let last = 200;
      for (let i = 0; i < 15 && last === 200; i++) last = (await post("/api/app/auth/start", { email: EMAIL, platform: "android" }, {}, "198.51.100.9")).status;
      expect(last).toBe(429);
    } finally {
      env.PLAY_INTEGRITY_SA = saved;
      env.APP_ATTEST_OFF = undefined;
    }
  });

  it("does not verify for a platform that is unavailable", async () => {
    expect((await post("/api/app/auth/verify", { email: EMAIL, code: "123456", platform: "ios" })).status).toBe(503);
  });

  it("rejects a wrong code", async () => {
    await startCode();
    const res = await post("/api/app/auth/verify", { email: EMAIL, code: "000000", platform: "android" });
    expect(res.status).toBe(400);
  });

  it("verifies only where the code was asked for", async () => {
    env.APP_URL = "http://localhost:8787";
    env.APP_ATTEST_OFF = "ios";
    try {
      const android = await startCode();
      expect((await post("/api/app/auth/verify", { email: EMAIL, code: android, platform: "ios" })).status).toBe(400);
      expect((await post("/api/auth/verify", { email: EMAIL, code: android })).status).toBe(400);
      expect((await post("/api/app/auth/verify", { email: EMAIL, code: android, platform: "android" })).status).toBe(200);

      const sent = mockOutbound();
      await api("/api/auth/start", { method: "POST", body: { email: EMAIL, turnstile: "t" } });
      const web = codeFrom(sent[0]);
      expect((await post("/api/app/auth/verify", { email: EMAIL, code: web, platform: "android" })).status).toBe(400);
      expect((await post("/api/auth/verify", { email: EMAIL, code: web })).status).toBe(200);
    } finally {
      env.APP_URL = "https://collect.alazy.app";
      env.APP_ATTEST_OFF = undefined;
    }
  });

  it("leaves the web sign-in on cookies", async () => {
    const sent = mockOutbound();
    await api("/api/auth/start", { method: "POST", body: { email: EMAIL, turnstile: "t" } });
    const res = await post("/api/auth/verify", { email: EMAIL, code: codeFrom(sent[0]) });
    expect(await res.json<any>()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toContain("__Host-lc_session=");
  });
});

describe("app passkey step", () => {
  async function atPasskeyStep() {
    const web = await login();
    const key = await Authenticator.create();
    expect((await addPasskey(web, key)).status).toBe(201);
    const res = await appSignIn();
    return { key, body: await res.json<any>(), res };
  }

  it("answers with a pending token and no session or cookie", async () => {
    const { body, res } = await atPasskeyStep();
    expect(body).toMatchObject({ ok: true, step: "passkey" });
    expect(body.token).toBeUndefined();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await api("/api/me", { headers: bearer(body.pending) })).status).toBe(401);
    expect((await (await api("/api/auth/pending", { headers: pendingHeader(body.pending) })).json<any>()).step).toBe("passkey");
  });

  it("finishes with the passkey and returns a session token", async () => {
    const { key, body } = await atPasskeyStep();
    const { options } = await (await post("/api/auth/pending/options", {}, pendingHeader(body.pending))).json<any>();
    const done = await post("/api/auth/pending/verify", { response: await key.assert(options) }, pendingHeader(body.pending));
    expect(done.status).toBe(200);
    expect(done.headers.get("set-cookie")).toBeNull();
    const { token } = await done.json<any>();
    expect((await api("/api/me", { headers: bearer(token) })).status).toBe(200);
    expect((await env.CONTROL.prepare("SELECT app FROM sessions ORDER BY created_at DESC").first<any>()).app).toBe("android");
    // the pending token is spent
    expect((await post("/api/auth/pending/options", {}, pendingHeader(body.pending))).status).toBe(401);
  });

  it("refuses a counter that went backwards", async () => {
    const { key, body } = await atPasskeyStep();
    await env.CONTROL.prepare("UPDATE passkeys SET counter = 5").run();
    const { options } = await (await post("/api/auth/pending/options", {}, pendingHeader(body.pending))).json<any>();
    const res = await post("/api/auth/pending/verify", { response: await key.assert(options, { counter: 2 }) }, pendingHeader(body.pending));
    expect(res.status).toBe(403);
    expect((await post("/api/auth/pending/options", {}, pendingHeader(body.pending))).status).toBe(401);
  });

  it("enrols a first passkey when the account requires one", async () => {
    await login();
    await env.CONTROL.prepare("UPDATE firms SET require_passkeys = 1").run();
    const body = await (await appSignIn()).json<any>();
    expect(body.step).toBe("enrol");
    const { kind, options } = await (await post("/api/auth/pending/options", {}, pendingHeader(body.pending))).json<any>();
    expect(kind).toBe("register");
    const fresh = await Authenticator.create();
    const done = await post("/api/auth/pending/verify", { response: await fresh.register(options), name: "Pixel" }, pendingHeader(body.pending));
    expect((await done.json<any>()).token).toBeTruthy();
  });

  it("names an unnamed passkey after the app, during sign-in and from a signed-in session", async () => {
    await login();
    await env.CONTROL.prepare("UPDATE firms SET require_passkeys = 1").run();
    const body = await (await appSignIn()).json<any>();
    const { options } = await (await post("/api/auth/pending/options", {}, pendingHeader(body.pending))).json<any>();
    const done = await post("/api/auth/pending/verify", { response: await (await Authenticator.create()).register(options) }, pendingHeader(body.pending));
    const { token } = await done.json<any>();
    const reg = await (await post("/api/passkeys/options", {}, bearer(token))).json<any>();
    expect((await post("/api/passkeys", { response: await (await Authenticator.create()).register(reg) }, bearer(token))).status).toBe(201);
    const names = (await env.CONTROL.prepare("SELECT name FROM passkeys").all<{ name: string }>()).results.map((r) => r.name);
    expect(names).toEqual(["Lazy Collect for Android", "Lazy Collect for Android"]);
  });

  it("does not read a pending token sent as a bearer", async () => {
    const { body } = await atPasskeyStep();
    expect(await (await api("/api/auth/pending", { headers: bearer(body.pending) })).json()).toEqual({ step: null });
  });
});
