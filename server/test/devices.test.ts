import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deviceLabel } from "../src/session";
import { sha256 } from "../src/util";
import { addMember, api, codeFrom, cookieFrom, login, mockOutbound, start } from "./helpers";

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function loginAs(email: string, ua: string) {
  const sent = mockOutbound();
  await start(email);
  const res = await api("/api/auth/verify", { method: "POST", body: { email, code: codeFrom(sent[0]) }, headers: { "User-Agent": ua } });
  return cookieFrom(res);
}

const sessions = async (cookie: string) => (await api("/api/sessions", { cookie })).json<any[]>();
const me = async (cookie: string) => (await api("/api/me", { cookie })).status;

describe("device labels", () => {
  it("names the browser and system in a few words", () => {
    expect(deviceLabel(CHROME_WIN)).toBe("Chrome on Windows");
    expect(deviceLabel(SAFARI_IPHONE)).toBe("Safari on iPhone");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0")).toBe("Edge on Windows");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox on macOS");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(deviceLabel("curl/8")).toBe("Unknown device");
    expect(deviceLabel(undefined)).toBe("Unknown device");
  });
});

describe("signed-in devices", () => {
  it("lists the user's sessions with a label and marks this device", async () => {
    const mine = await loginAs("owner@firm.test", CHROME_WIN);
    const phone = await loginAs("owner@firm.test", SAFARI_IPHONE);
    const list = await sessions(mine);
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.current).label).toBe("Chrome on Windows");
    expect(list.find((s) => !s.current).label).toBe("Safari on iPhone");
    expect(list.every((s) => s.created_at > 0 && s.last_seen_at > 0 && !("token_hash" in s))).toBe(true);
    expect((await sessions(phone)).find((s) => s.current).label).toBe("Safari on iPhone");
    expect((await api("/api/sessions")).status).toBe(401);
  });

  it("does not keep the raw user agent", async () => {
    await loginAs("owner@firm.test", CHROME_WIN);
    const row = await env.CONTROL.prepare("SELECT * FROM sessions").first<any>();
    expect(JSON.stringify(row)).not.toContain("Mozilla");
  });

  it("updates last seen at most once an hour", async () => {
    const cookie = await login();
    const hash = await sha256(cookie.split("=")[1]);
    const seen = async () => (await env.CONTROL.prepare("SELECT last_seen_at FROM sessions WHERE token_hash = ?").bind(hash).first<{ last_seen_at: number }>())!.last_seen_at;
    const first = await seen();
    await api("/api/me", { cookie });
    expect(await seen()).toBe(first);
    await env.CONTROL.prepare("UPDATE sessions SET last_seen_at = last_seen_at - 3700000 WHERE token_hash = ?").bind(hash).run();
    const old = await seen();
    await api("/api/me", { cookie });
    expect(await seen()).toBeGreaterThan(old + 3600000);
  });

  it("signs out one other session, and not this one", async () => {
    const mine = await loginAs("owner@firm.test", CHROME_WIN);
    const other = await loginAs("owner@firm.test", SAFARI_IPHONE);
    const list = await sessions(mine);
    const ours = list.find((s) => s.current);
    const theirs = list.find((s) => !s.current);
    expect((await api(`/api/sessions/${ours.id}`, { method: "DELETE", cookie: mine })).status).toBe(409);
    expect((await api(`/api/sessions/${theirs.id}`, { method: "DELETE", cookie: mine })).status).toBe(200);
    expect(await me(other)).toBe(401);
    expect(await me(mine)).toBe(200);
    expect((await api(`/api/sessions/${theirs.id}`, { method: "DELETE", cookie: mine })).status).toBe(404);
  });

  it("signs out everywhere else", async () => {
    const mine = await loginAs("owner@firm.test", CHROME_WIN);
    const a = await loginAs("owner@firm.test", SAFARI_IPHONE);
    const b = await loginAs("owner@firm.test", CHROME_WIN);
    const teammate = await addMember(mine);
    expect((await api("/api/sessions/end-others", { method: "POST", cookie: mine })).status).toBe(200);
    expect(await me(a)).toBe(401);
    expect(await me(b)).toBe(401);
    expect(await me(mine)).toBe(200);
    expect(await me(teammate)).toBe(200);
    expect(await sessions(mine)).toHaveLength(1);
    const acts = (await env.DB_NA.prepare("SELECT action FROM audit WHERE action LIKE 'session.%'").all<{ action: string }>()).results;
    expect(acts.map((r) => r.action)).toEqual(["session.end_others"]);
  });

  it("never reaches another user's or another account's session", async () => {
    const owner = await login("owner@firm.test");
    const member = await addMember(owner);
    const stranger = await login("other@firm.test");
    const victim = (await sessions(member))[0];
    expect((await api(`/api/sessions/${victim.id}`, { method: "DELETE", cookie: owner })).status).toBe(404);
    expect((await api(`/api/sessions/${victim.id}`, { method: "DELETE", cookie: stranger })).status).toBe(404);
    expect((await api("/api/sessions/end-others", { method: "POST", cookie: stranger })).status).toBe(200);
    expect(await me(member)).toBe(200);
    expect((await sessions(owner)).map((s) => s.id)).not.toContain(victim.id);
  });
});

describe("owner signs a member out", () => {
  it("shows session counts in People and ends them all", async () => {
    const owner = await login();
    const member = await addMember(owner);
    const people = (await (await api("/api/staff", { cookie: owner })).json<any>()).people;
    expect(people.map((p: any) => [p.email, p.sessions])).toEqual([["owner@firm.test", 1], ["member@firm.test", 1]]);
    const id = people.find((p: any) => p.role === "member").id;
    expect((await api(`/api/staff/${id}/sign-out`, { method: "POST", cookie: owner })).status).toBe(200);
    expect(await me(member)).toBe(401);
    expect(await me(owner)).toBe(200);
    expect((await env.DB_NA.prepare("SELECT action FROM audit WHERE action = 'staff.sign_out'").all()).results).toHaveLength(1);
  });

  it("is for owners, other accounts' people and not oneself", async () => {
    const owner = await login();
    const member = await addMember(owner);
    const stranger = await login("other@firm.test");
    const ownerId = (await (await api("/api/me", { cookie: owner })).json<any>()).user.id;
    const memberId = (await (await api("/api/me", { cookie: member })).json<any>()).user.id;
    expect((await api(`/api/staff/${ownerId}/sign-out`, { method: "POST", cookie: member })).status).toBe(403);
    expect((await api(`/api/staff/${memberId}/sign-out`, { method: "POST", cookie: stranger })).status).toBe(404);
    expect((await api(`/api/staff/${ownerId}/sign-out`, { method: "POST", cookie: owner })).status).toBe(409);
    expect((await api(`/api/staff/${"0".repeat(32)}/sign-out`, { method: "POST", cookie: owner })).status).toBe(404);
    expect(await me(member)).toBe(200);
  });
});
