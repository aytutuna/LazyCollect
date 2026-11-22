import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { YEAR } from "../src/status";
import { randomId } from "../src/util";
import { api, login, openRequest, pdf, review, upload } from "./helpers";

const row = async () => (await env.DB_NA.prepare("SELECT status, ended_at, keep_until, hold_at, deleted_at FROM requests").first<any>())!;

async function submitted() {
  const o = await openRequest();
  const item = o.req.items[0].id;
  await upload(o.path, item, pdf(500));
  return { ...o, item };
}

describe("retention", () => {
  it("defaults to 7 years and starts the clock at close", async () => {
    const { cookie, req } = await openRequest();
    expect((await row()).ended_at).toBeNull();
    expect(await (await api("/api/retention", { cookie })).json()).toEqual({ years: 7 });
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    const r = await row();
    expect(r.ended_at).toBeGreaterThan(0);
    expect(r.keep_until).toBe(r.ended_at + 7 * YEAR);
    const detail = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    expect(detail).toMatchObject({ ended_at: r.ended_at, keep_until: r.keep_until, hold_at: null });
  });

  it("starts the clock when a request completes and clears it when it reopens", async () => {
    const { cookie, req, item } = await submitted();
    const done = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    expect(done.status).toBe("complete");
    expect((await row()).keep_until).toBe((await row()).ended_at + 7 * YEAR);
    await review(cookie, req.id, item, { decision: "reject", note: "Blurry" });
    expect(await row()).toMatchObject({ status: "open", ended_at: null, keep_until: null });
  });

  it("keeps the first start when a completed request is closed", async () => {
    const { cookie, req } = await submitted();
    await env.DB_NA.prepare("UPDATE requests SET status = 'complete', ended_at = 1000, keep_until = 5000").run();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    expect(await row()).toMatchObject({ status: "closed", ended_at: 1000, keep_until: 1000 + 7 * YEAR });
  });

  it("moves every keep_until when the owner changes the setting", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    const open = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: req.client_id, title: "Later", deadline: Date.now() + 86_400_000 } })).json<any>();
    const res = await api("/api/retention", { method: "PUT", cookie, body: { years: 3 } });
    expect(res.status).toBe(200);
    const closed = (await env.DB_NA.prepare("SELECT ended_at, keep_until FROM requests WHERE id = ?").bind(req.id).first<any>())!;
    expect(closed.keep_until).toBe(closed.ended_at + 3 * YEAR);
    expect((await env.DB_NA.prepare("SELECT keep_until FROM requests WHERE id = ?").bind(open.id).first<any>())!.keep_until).toBeNull();
    expect(await (await api("/api/retention", { cookie })).json()).toEqual({ years: 3 });
    // new endings use the new setting
    await api(`/api/requests/${open.id}/close`, { method: "POST", cookie });
    const later = (await env.DB_NA.prepare("SELECT ended_at, keep_until FROM requests WHERE id = ?").bind(open.id).first<any>())!;
    expect(later.keep_until).toBe(later.ended_at + 3 * YEAR);
    expect((await env.DB_NA.prepare("SELECT action FROM audit WHERE action = 'retention.update'").all()).results).toHaveLength(1);
  });

  it("takes 1 to 10 whole years from the owner only", async () => {
    const { cookie } = await openRequest();
    for (const years of [0, 11, 2.5, "7", null]) {
      expect([years, (await api("/api/retention", { method: "PUT", cookie, body: { years } })).status]).toEqual([years, 400]);
    }
    const firmId = (await env.CONTROL.prepare("SELECT id FROM firms").first<any>())!.id;
    await env.CONTROL.prepare("INSERT INTO users (id, firm_id, email, role, created_at) VALUES (?, ?, 'staff@firm.test', 'member', ?)").bind(randomId(), firmId, Date.now()).run();
    const staff = await login("staff@firm.test");
    expect((await api("/api/retention", { method: "PUT", cookie: staff, body: { years: 2 } })).status).toBe(403);
    expect((await api("/api/retention", { cookie: staff })).status).toBe(200);
  });
});

describe("legal hold", () => {
  it("is toggled by staff, audited, and blocks deleting the request", async () => {
    const { cookie, req } = await openRequest();
    const hold = (on: boolean) => api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on } });
    expect((await hold(true)).status).toBe(200);
    expect((await row()).hold_at).toBeGreaterThan(0);
    const blocked = await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "legal_hold" });
    expect((await row()).deleted_at).toBeNull();
    expect((await hold(false)).status).toBe(200);
    expect((await api(`/api/requests/${req.id}`, { method: "DELETE", cookie })).status).toBe(200);
    const actions = (await env.DB_NA.prepare("SELECT action FROM audit WHERE action LIKE 'request.%' ORDER BY rowid").all<any>()).results.map((r) => r.action);
    expect(actions).toEqual(["request.create", "request.hold", "request.release", "request.delete"]);
    expect((await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: "yes" } })).status).toBe(400);
  });

  it("blocks deleting a client with a held request", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: true } });
    const res = await api(`/api/clients/${req.client_id}`, { method: "DELETE", cookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "legal_hold" });
    expect((await env.DB_NA.prepare("SELECT deleted_at FROM clients").first<any>())!.deleted_at).toBeNull();
    expect((await row()).status).toBe("open");
    expect((await env.DB_NA.prepare("SELECT revoked_at FROM links").first<any>())!.revoked_at).toBeNull();
  });

  it("starts a client delete's closed requests on the retention clock", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/clients/${req.client_id}`, { method: "DELETE", cookie });
    const r = await row();
    expect(r.status).toBe("closed");
    expect(r.keep_until).toBe(r.ended_at + 7 * YEAR);
  });

  it("answers another firm with 404", async () => {
    const { req } = await openRequest();
    const other = await login("other@firm.test");
    expect((await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie: other, body: { on: true } })).status).toBe(404);
  });
});
