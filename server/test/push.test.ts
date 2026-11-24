import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/util";
import { bearer, post, proof } from "./app";
import { api, codeFrom, login, mockOutbound, openRequest } from "./helpers";

async function staffApp(email = "owner@firm.test") {
  const sent = mockOutbound();
  await post("/api/app/auth/start", { email, platform: "android", attestation: await proof(email) });
  const res = await post("/api/app/auth/verify", { email, code: codeFrom(sent[sent.length - 1]), platform: "android" });
  return (await res.json<any>()).token as string;
}

async function clientApp(email = "owner@firm.test") {
  const link = (await openRequest(email)).path.split("/c/")[1];
  mockOutbound();
  return (await (await post("/api/app/client/exchange", { token: link, platform: "android", attestation: await proof(link) })).json<any>()).token as string;
}

const register = (token: string, push: unknown) => api("/api/app/push", { method: "PUT", headers: bearer(token), body: { token: push } });
const stored = async (table: "sessions" | "client_sessions", token: string) =>
  (await env.CONTROL.prepare(`SELECT push_token FROM ${table} WHERE token_hash = ?`).bind(await sha256(token)).first<{ push_token: string | null }>())?.push_token;

describe("push registration", () => {
  it("stores the device token on a staff app session and clears it", async () => {
    const token = await staffApp();
    expect((await register(token, "fcm-1")).status).toBe(200);
    expect(await stored("sessions", token)).toBe("fcm-1");
    expect((await register(token, "fcm-2")).status).toBe(200);
    expect(await stored("sessions", token)).toBe("fcm-2");
    expect((await api("/api/app/push", { method: "DELETE", headers: bearer(token) })).status).toBe(200);
    expect(await stored("sessions", token)).toBeNull();
  });

  it("stores it on a client session too", async () => {
    const token = await clientApp();
    expect((await register(token, "fcm-c")).status).toBe(200);
    expect(await stored("client_sessions", token)).toBe("fcm-c");
  });

  it("is refused for a client session whose link is gone", async () => {
    const token = await clientApp();
    await env.DB_NA.prepare("UPDATE links SET revoked_at = ?").bind(Date.now()).run();
    expect((await register(token, "fcm-c")).status).toBe(401);
    expect(await stored("client_sessions", token)).toBeNull();
  });

  it("goes with the session", async () => {
    const web = await login();
    const token = await staffApp();
    await register(token, "fcm-1");
    const list = await (await api("/api/sessions", { cookie: web })).json<any[]>();
    await api(`/api/sessions/${list.find((s) => s.label.includes("Android")).id}`, { method: "DELETE", cookie: web });
    expect(await stored("sessions", token)).toBeUndefined();
    expect((await env.CONTROL.prepare("SELECT COUNT(*) AS n FROM sessions WHERE push_token IS NOT NULL").first<any>()).n).toBe(0);
    expect((await register(token, "fcm-1")).status).toBe(401);

    const client = await clientApp();
    await register(client, "fcm-c");
    await post("/api/app/client/logout", {}, bearer(client));
    expect((await env.CONTROL.prepare("SELECT COUNT(*) AS n FROM client_sessions WHERE push_token IS NOT NULL").first<any>()).n).toBe(0);
  });

  it("moves a token to the other user's staff session that registers it", async () => {
    const first = await staffApp("a@firm.test");
    const second = await staffApp("b@firm.test");
    await register(first, "shared");
    await register(second, "shared");
    expect(await stored("sessions", first)).toBeNull();
    expect(await stored("sessions", second)).toBe("shared");
  });

  it("lets one install's sessions share a token", async () => {
    const one = await clientApp("a@firm.test");
    const two = await clientApp("b@firm.test");
    await register(one, "shared");
    await register(two, "shared");
    expect(await stored("client_sessions", one)).toBe("shared");
    expect(await stored("client_sessions", two)).toBe("shared");

    const staff = await staffApp("c@firm.test");
    await register(staff, "shared");
    expect(await stored("client_sessions", one)).toBe("shared");
    expect(await stored("sessions", staff)).toBe("shared");
    await register(one, "shared");
    expect(await stored("sessions", staff)).toBe("shared");
  });

  it("leaves other users' tokens alone", async () => {
    const a = await staffApp("a@firm.test");
    const b = await staffApp("b@firm.test");
    await register(a, "a-token");
    await register(b, "b-token");
    await api("/api/app/push", { method: "DELETE", headers: bearer(a) });
    expect(await stored("sessions", b)).toBe("b-token");
  });

  it("refuses a browser session, an unknown token, an expired session and no credentials", async () => {
    const web = await login();
    expect((await api("/api/app/push", { method: "PUT", cookie: web, body: { token: "x" } })).status).toBe(401);
    expect((await register("nope", "x")).status).toBe(401);
    expect((await api("/api/app/push", { method: "PUT", body: { token: "x" } })).status).toBe(401);
    const token = await staffApp();
    await env.CONTROL.prepare("UPDATE sessions SET expires_at = ? WHERE app IS NOT NULL").bind(Date.now() - 1).run();
    expect((await register(token, "x")).status).toBe(401);
  });

  it("refuses a missing or oversized token", async () => {
    const token = await staffApp();
    expect((await register(token, "")).status).toBe(400);
    expect((await register(token, 5)).status).toBe(400);
    expect((await register(token, "x".repeat(4097))).status).toBe(400);
  });
});
