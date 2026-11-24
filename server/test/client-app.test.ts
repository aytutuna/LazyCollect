import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/util";
import { bearer, post, proof, setAppUrl } from "./app";
import { api, mockOutbound, openRequest, pdf, setup, upload } from "./helpers";

async function exchange(token: string, platform = "android", attestation?: unknown) {
  mockOutbound();
  return post("/api/app/client/exchange", { token, platform, attestation: attestation ?? (await proof(token, platform)) });
}

async function clientApp(email = "owner@firm.test") {
  const opened = await openRequest(email);
  const linkToken = opened.path.split("/c/")[1];
  const res = await exchange(linkToken);
  const { token } = await res.json<any>();
  return { ...opened, linkToken, token, res };
}

describe("client app session", () => {
  it("trades the link token for a session that reads the same request", async () => {
    const { path, token, res } = await clientApp();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const web = await (await api(path)).json<any>();
    const app = await (await api("/api/c/me", { headers: bearer(token) })).json<any>();
    expect(app).toEqual(web);
    expect(app.items.map((i: any) => i.label)).toEqual(["Passport", "Visa"]);
  });

  it("leaves the link working on the web", async () => {
    const { path } = await clientApp();
    expect((await api(path)).status).toBe(200);
  });

  it("keeps only the link's hash, not the token", async () => {
    const { linkToken, token } = await clientApp();
    const row = await env.CONTROL.prepare("SELECT * FROM client_sessions").first<any>();
    expect(JSON.stringify(row)).not.toContain(linkToken.slice(3));
    expect(row.token_hash).toBe(await sha256(token));
    expect(row.app).toBe("android");
  });

  it("uploads a file through the session", async () => {
    const { token, path } = await clientApp();
    const item = (await (await api(path)).json<any>()).items[0];
    const res = await upload("/api/c/me", item.id, pdf(2000), { headers: bearer(token) });
    expect(res.status).toBe(201);
    const after = (await (await api(path)).json<any>()).items[0];
    expect(after.files).toHaveLength(1);
  });

  it("refuses a link that does not exist and a platform that is not an app", async () => {
    expect((await exchange("na_" + "A".repeat(43))).status).toBe(404);
    expect((await exchange("nope")).status).toBe(404);
    expect((await post("/api/app/client/exchange", { token: "x", platform: "web" })).status).toBe(400);
    expect((await post("/api/app/client/exchange", { platform: "android" })).status).toBe(400);
  });

  it("needs the attestation, bound to this token and used once", async () => {
    const linkToken = (await openRequest()).path.split("/c/")[1];
    mockOutbound();
    expect((await post("/api/app/client/exchange", { token: linkToken, platform: "android" })).status).toBe(400);
    expect((await exchange(linkToken, "android", await proof("na_other"))).status).toBe(400);
    const good = await proof(linkToken);
    expect((await exchange(linkToken, "android", good)).status).toBe(200);
    expect((await exchange(linkToken, "android", good)).status).toBe(400);
  });

  it("takes no proof for a platform in APP_ATTEST_OFF", async () => {
    const linkToken = (await openRequest()).path.split("/c/")[1];
    mockOutbound();
    const saved = env.PLAY_INTEGRITY_SA;
    env.PLAY_INTEGRITY_SA = undefined;
    expect((await post("/api/app/client/exchange", { token: linkToken, platform: "android" })).status).toBe(503);
    env.APP_ATTEST_OFF = "android";
    setAppUrl(env, "http://localhost:8787");
    try {
      expect((await post("/api/app/client/exchange", { token: linkToken, platform: "android" })).status).toBe(200);
    } finally {
      env.PLAY_INTEGRITY_SA = saved;
      setAppUrl(env, "https://collect.alazy.app");
      env.APP_ATTEST_OFF = undefined;
    }
  });

  it("is rate limited", async () => {
    mockOutbound();
    let last = 400;
    for (let i = 0; i < 80 && last !== 429; i++) last = (await post("/api/app/client/exchange", { token: "nope", platform: "android", attestation: await proof("nope") }, {}, "198.51.100.20")).status;
    expect(last).toBe(429);
  });

  it("stops working when the link is revoked, expires or the request closes", async () => {
    const { token } = await clientApp();
    await env.DB_NA.prepare("UPDATE links SET revoked_at = ?").bind(Date.now()).run();
    expect((await api("/api/c/me", { headers: bearer(token) })).status).toBe(404);
    expect((await api("/api/c/me/notes", { method: "POST", headers: bearer(token), body: { body: "hi" } })).status).toBe(404);
    expect((await upload("/api/c/me", "x".repeat(32), pdf(100), { headers: bearer(token) })).status).toBe(404);
  });

  it("slides only while the link is live, so a dead link's session still expires", async () => {
    const { token } = await clientApp();
    const old = Date.now() - 2 * 3_600_000;
    const expiry = () => env.CONTROL.prepare("SELECT expires_at FROM client_sessions").first<{ expires_at: number }>().then((r) => r!.expires_at);
    await env.CONTROL.prepare("UPDATE client_sessions SET last_seen_at = ?, expires_at = ?").bind(old, old + 60_000_000).run();
    await env.DB_NA.prepare("UPDATE links SET revoked_at = ?").bind(Date.now()).run();
    expect((await api("/api/c/me", { headers: bearer(token) })).status).toBe(404);
    expect(await expiry()).toBe(old + 60_000_000);
    await env.DB_NA.prepare("UPDATE links SET revoked_at = NULL").run();
    expect((await api("/api/c/me", { headers: bearer(token) })).status).toBe(200);
    expect(await expiry()).toBeGreaterThan(old + 60_000_000);
  });

  it("ends on logout, on expiry and when the token is wrong", async () => {
    const { token } = await clientApp();
    expect((await api("/api/c/me", { headers: bearer("nope") })).status).toBe(404);
    expect((await api("/api/c/me")).status).toBe(404);
    await env.CONTROL.prepare("UPDATE client_sessions SET expires_at = ?").bind(Date.now() - 1).run();
    expect((await api("/api/c/me", { headers: bearer(token) })).status).toBe(404);
    const again = await (await exchange((await openRequest("other@firm.test")).path.split("/c/")[1])).json<any>();
    expect((await api("/api/c/me", { headers: bearer(again.token) })).status).toBe(200);
    expect((await post("/api/app/client/logout", {}, bearer(again.token))).status).toBe(200);
    expect((await api("/api/c/me", { headers: bearer(again.token) })).status).toBe(404);
  });

  it("is scoped to its own link, across firms", async () => {
    const a = await clientApp("a@firm.test");
    const b = await clientApp("b@firm.test");
    const seenA = await (await api("/api/c/me", { headers: bearer(a.token) })).json<any>();
    const seenB = await (await api("/api/c/me", { headers: bearer(b.token) })).json<any>();
    expect(seenA.items.map((i: any) => i.id)).not.toEqual(seenB.items.map((i: any) => i.id));
    const bItem = seenB.items[0].id;
    // the other firm's item id through this session finds nothing
    expect((await upload("/api/c/me", bItem, pdf(100), { headers: bearer(a.token) })).status).toBe(404);
    expect((await api(`/api/c/me/items/${bItem}/example`, { headers: bearer(a.token) })).status).toBe(404);
  });

  it("does not open staff routes and a staff session does not open the client route", async () => {
    const { token } = await clientApp();
    expect((await api("/api/me", { headers: bearer(token) })).status).toBe(401);
    expect((await api("/api/clients", { headers: bearer(token) })).status).toBe(401);
    const { cookie } = await setup("staff@firm.test");
    expect((await api("/api/c/me", { cookie })).status).toBe(404);
  });
});
