import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { HOUR, randomId, randomToken, sha256 } from "../src/util";
import { api, login } from "./helpers";

// a session the way an app sign-in leaves it
async function appSession(cookie: string, app: "android" | "ios" = "android") {
  const me = await (await api("/api/me", { cookie })).json<any>();
  const token = randomToken();
  const now = Date.now();
  await env.CONTROL.prepare("INSERT INTO sessions (id, token_hash, user_id, firm_id, label, app, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(randomId(), await sha256(token), me.user.id, me.firm.id, "Lazy Collect for Android", app, now, now, now + 1_000_000)
    .run();
  return { token, hash: await sha256(token) };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("bearer sessions", () => {
  it("signs in an app request without a cookie", async () => {
    const { token } = await appSession(await login());
    const res = await api("/api/me", { headers: bearer(token) });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).user.email).toBe("owner@firm.test");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses an unknown, ended or expired token", async () => {
    const { token, hash } = await appSession(await login());
    expect((await api("/api/me", { headers: bearer("nope") })).status).toBe(401);
    await env.CONTROL.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(Date.now() - 1, hash).run();
    expect((await api("/api/me", { headers: bearer(token) })).status).toBe(401);
    await env.CONTROL.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    expect((await api("/api/me", { headers: bearer(token) })).status).toBe(401);
  });

  it("does not fall back to a cookie when the bearer is wrong", async () => {
    const cookie = await login();
    expect((await api("/api/me", { cookie, headers: bearer("nope") })).status).toBe(401);
  });

  it("stops working when the user is disabled", async () => {
    const { token } = await appSession(await login());
    await env.CONTROL.prepare("UPDATE users SET disabled_at = ?").bind(Date.now()).run();
    expect((await api("/api/me", { headers: bearer(token) })).status).toBe(401);
  });

  it("keeps the session alive for as long as a web one, without setting a cookie", async () => {
    const { token, hash } = await appSession(await login());
    await env.CONTROL.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").bind(Date.now() - 2 * HOUR, hash).run();
    const res = await api("/api/me", { headers: bearer(token) });
    expect(res.headers.get("set-cookie")).toBeNull();
    const row = await env.CONTROL.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").bind(hash).first<{ expires_at: number }>();
    expect(row!.expires_at).toBeGreaterThan(Date.now() + 29 * 24 * HOUR);
  });

  it("shows up in the signed-in devices and can be ended from the web", async () => {
    const cookie = await login();
    const { token } = await appSession(cookie);
    const list = await (await api("/api/sessions", { cookie })).json<any[]>();
    const app = list.find((s) => s.label === "Lazy Collect for Android")!;
    expect(app.current).toBe(false);
    expect((await api(`/api/sessions/${app.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await api("/api/me", { headers: bearer(token) })).status).toBe(401);
  });

  it("ends itself on logout", async () => {
    const { token } = await appSession(await login());
    expect((await api("/api/auth/logout", { method: "POST", headers: bearer(token) })).status).toBe(200);
    expect((await api("/api/me", { headers: bearer(token) })).status).toBe(401);
  });
});
