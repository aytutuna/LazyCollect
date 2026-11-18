import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, codeFrom, cookieFrom, linkFrom, mockOutbound, start } from "./helpers";

const EMAIL = "owner@firm.test";

async function signIn(sent: ReturnType<typeof mockOutbound>, email = EMAIL) {
  await start(email);
  return api("/api/auth/verify", { method: "POST", body: { email, code: codeFrom(sent.at(-1)!) } });
}

describe("start", () => {
  it("answers 200 and sends one email for a new address", async () => {
    const sent = mockOutbound();
    const res = await start("  Owner@Firm.test ");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([EMAIL]);
    expect(codeFrom(sent[0])).toMatch(/^\d{6}$/);
    expect(linkFrom(sent[0])).toMatch(/^\/api\/auth\/link\?t=[\w-]{43}$/);
  });

  it("stores only hashes of the code and the link token", async () => {
    const sent = mockOutbound();
    await start(EMAIL);
    const code = codeFrom(sent[0]);
    const token = linkFrom(sent[0]).split("t=")[1];
    const { results } = await env.CONTROL.prepare("SELECT * FROM login_codes").all<Record<string, unknown>>();
    expect(results).toHaveLength(1);
    expect(Object.values(results[0])).not.toContain(code);
    expect(JSON.stringify(results[0])).not.toContain(token);
    expect(results[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(results[0].link_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends nothing for a 4th request within 10 minutes", async () => {
    const sent = mockOutbound();
    for (let i = 0; i < 4; i++) expect((await start(EMAIL)).status).toBe(200);
    expect(sent).toHaveLength(3);
  });

  it("fails with 4xx and sends nothing when Turnstile rejects", async () => {
    const sent = mockOutbound(false);
    const res = await start(EMAIL);
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("verify", () => {
  it("creates firm, owner and a session that /api/me accepts", async () => {
    const sent = mockOutbound();
    const res = await signIn(sent);
    expect(res.status).toBe(200);
    const header = res.headers.get("set-cookie")!;
    expect(header).toMatch(/^lc_session=[\w-]{43};/);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Max-Age=2592000");

    const me = await api("/api/me", { cookie: cookieFrom(res) });
    expect(me.status).toBe(200);
    const body = await me.json<any>();
    expect(body.user).toMatchObject({ email: EMAIL, name: null, role: "owner" });
    expect(body.firm).toMatchObject({ name: null, plan_status: "trialing" });
    expect(body.firm.trial_ends_at).toBeGreaterThan(Date.now() + 13 * 86_400_000);

    const { results } = await env.CONTROL.prepare("SELECT token_hash FROM sessions").all<{ token_hash: string }>();
    expect(results).toHaveLength(1);
    expect(cookieFrom(res)).not.toContain(results[0].token_hash);
  });

  it("returns 401 from /api/me without a session", async () => {
    expect((await api("/api/me")).status).toBe(401);
  });

  it("kills the code after 3 wrong tries", async () => {
    const sent = mockOutbound();
    await start(EMAIL);
    const code = codeFrom(sent[0]);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) {
      const res = await api("/api/auth/verify", { method: "POST", body: { email: EMAIL, code: wrong } });
      expect(res.status).toBe(400);
    }
    const res = await api("/api/auth/verify", { method: "POST", body: { email: EMAIL, code } });
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects an expired code", async () => {
    const sent = mockOutbound();
    await start(EMAIL);
    await env.CONTROL.prepare("UPDATE login_codes SET expires_at = ?").bind(Date.now() - 1).run();
    const res = await api("/api/auth/verify", { method: "POST", body: { email: EMAIL, code: codeFrom(sent[0]) } });
    expect(res.status).toBe(400);
  });

  it("does not accept a code twice", async () => {
    const sent = mockOutbound();
    expect((await signIn(sent)).status).toBe(200);
    const again = await api("/api/auth/verify", { method: "POST", body: { email: EMAIL, code: codeFrom(sent[0]) } });
    expect(again.status).toBe(400);
  });

  it("reuses the user and firm on a second sign-in", async () => {
    const sent = mockOutbound();
    const first = await signIn(sent);
    const second = await signIn(sent);
    expect(second.status).toBe(200);
    const a = await (await api("/api/me", { cookie: cookieFrom(first) })).json<any>();
    const b = await (await api("/api/me", { cookie: cookieFrom(second) })).json<any>();
    expect(b.user.id).toBe(a.user.id);
    expect(b.firm.id).toBe(a.firm.id);
    const users = await env.CONTROL.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(users!.n).toBe(1);
  });

  it("refuses a disabled user", async () => {
    const sent = mockOutbound();
    await signIn(sent);
    await env.CONTROL.prepare("UPDATE users SET disabled_at = ?").bind(Date.now()).run();
    const res = await signIn(sent);
    expect(res.status).toBe(403);
  });
});

describe("link", () => {
  it("signs in once and redirects to /", async () => {
    const sent = mockOutbound();
    await start(EMAIL);
    const link = linkFrom(sent[0]);
    const res = await api(link);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const me = await api("/api/me", { cookie: cookieFrom(res) });
    expect(me.status).toBe(200);
    expect((await api(link)).status).toBe(400);
  });
});

describe("logout", () => {
  it("ends the session", async () => {
    const sent = mockOutbound();
    const cookie = cookieFrom(await signIn(sent));
    const res = await api("/api/auth/logout", { method: "POST", cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("lc_session=;");
    expect((await api("/api/me", { cookie })).status).toBe(401);
  });
});

describe("csrf", () => {
  it("rejects a POST without X-Collect", async () => {
    mockOutbound();
    const res = await api("/api/auth/start", { method: "POST", body: { email: EMAIL, turnstile: "tok" }, headers: { "X-Collect": "0" } });
    expect(res.status).toBe(403);
  });

  it("rejects a POST from another origin", async () => {
    const sent = mockOutbound();
    const res = await api("/api/auth/start", {
      method: "POST",
      body: { email: EMAIL, turnstile: "tok" },
      headers: { Origin: "https://evil.test" },
    });
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("accepts the app's own origin", async () => {
    mockOutbound();
    const res = await api("/api/auth/start", {
      method: "POST",
      body: { email: EMAIL, turnstile: "tok" },
      headers: { Origin: "https://collect.alazy.app" },
    });
    expect(res.status).toBe(200);
  });
});
