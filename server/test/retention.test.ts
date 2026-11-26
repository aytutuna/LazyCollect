import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeExpired } from "../src/purge";
import { sweepFiles } from "../src/sweep";
import { YEAR } from "../src/status";
import { DAY } from "../src/util";
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

describe("expired requests", () => {
  const GRACE = 30 * DAY;
  const lapse = (days: number) => env.DB_NA.prepare("UPDATE requests SET deadline = ?").bind(Date.now() - days * DAY).run();

  it("start their clock when the link runs out, from the firm's retention", async () => {
    const { cookie } = await openRequest();
    await api("/api/retention", { method: "PUT", cookie, body: { years: 3 } });
    await lapse(10);
    await purgeExpired(env);
    expect((await row()).ended_at).toBeNull();
    await lapse(31);
    const deadline = (await env.DB_NA.prepare("SELECT deadline FROM requests").first<any>())!.deadline;
    await purgeExpired(env);
    expect(await row()).toMatchObject({ status: "open", ended_at: deadline + GRACE, keep_until: deadline + GRACE + 3 * YEAR, deleted_at: null });
  });

  it("are moved to Recently deleted once the period is over", async () => {
    await openRequest();
    await lapse(31);
    await purgeExpired(env);
    expect((await row()).deleted_at).toBeNull();
    await purgeExpired(env, Date.now() + 8 * YEAR);
    expect((await row()).deleted_at).toBeGreaterThan(0);
  });

  it("get a clock on legal hold but are not deleted while held", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: true } });
    await lapse(31);
    await purgeExpired(env);
    expect((await row()).ended_at).toBeGreaterThan(0);
    await purgeExpired(env, Date.now() + 8 * YEAR);
    expect(await row()).toMatchObject({ deleted_at: null });
  });

  it("leave drafts alone, and a later deadline stops the clock", async () => {
    const { cookie, req } = await openRequest();
    const draft = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: req.client_id, title: "Draft", deadline: Date.now() + DAY } })).json<any>();
    await env.DB_NA.prepare("UPDATE requests SET deadline = ?").bind(Date.now() - 40 * DAY).run();
    await purgeExpired(env);
    const rows = (await env.DB_NA.prepare("SELECT id, ended_at FROM requests").all<any>()).results;
    expect(rows.find((r) => r.id === draft.id).ended_at).toBeNull();
    expect(rows.find((r) => r.id === req.id).ended_at).toBeGreaterThan(0);
    const res = await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { deadline: Date.now() + 5 * DAY } });
    expect(res.status).toBe(200);
    expect((await env.DB_NA.prepare("SELECT ended_at, keep_until FROM requests WHERE id = ?").bind(req.id).first<any>())).toEqual({ ended_at: null, keep_until: null });
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

  it("refuses a hold on a request whose client is deleted", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/clients/${req.client_id}`, { method: "DELETE", cookie });
    const res = await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: true } });
    expect([res.status, await res.json()]).toEqual([409, { error: "client_deleted" }]);
    expect((await row()).hold_at).toBeNull();
  });

  it("answers another firm with 404", async () => {
    const { req } = await openRequest();
    const other = await login("other@firm.test");
    expect((await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie: other, body: { on: true } })).status).toBe(404);
  });
});

describe("what a hold protects", () => {
  async function held() {
    const o = await openRequest();
    const file = await (await upload(o.path, o.req.items[0].id, pdf(400))).json<any>();
    await api(`/api/requests/${o.req.id}/hold`, { method: "PUT", cookie: o.cookie, body: { on: true } });
    return { ...o, file };
  }

  it("refuses a client removing a file and keeps the file", async () => {
    const { path, file } = await held();
    const res = await api(`${path}/files/${file.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "legal_hold" });
    expect((await env.DB_NA.prepare("SELECT deleted_at FROM files").first<any>())!.deleted_at).toBeNull();
    expect((await env.FILES_NA.list({ prefix: "f/" })).objects).toHaveLength(1);
  });

  it("refuses staff removing a checklist item", async () => {
    const { cookie, req } = await held();
    const res = await api(`/api/requests/${req.id}/items/${req.items[1].id}`, { method: "DELETE", cookie });
    expect([res.status, await res.json()]).toEqual([409, { error: "legal_hold" }]);
  });

  it("keeps the sweep away from removed files of a held request", async () => {
    const { req, file } = await held();
    await env.DB_NA.prepare("UPDATE files SET deleted_at = 1 WHERE id = ?").bind(file.id).run();
    await sweepFiles(env);
    expect([await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM files").first<any>(), (await env.FILES_NA.list({ prefix: "f/" })).objects.length]).toEqual([{ n: 1 }, 1]);
    await env.DB_NA.prepare("UPDATE requests SET hold_at = NULL WHERE id = ?").bind(req.id).run();
    await sweepFiles(env);
    expect((await env.FILES_NA.list({ prefix: "f/" })).objects).toHaveLength(0);
  });

  it("lets staff set a hold but only the owner release it", async () => {
    const { cookie, req } = await openRequest();
    const firmId = (await env.CONTROL.prepare("SELECT id FROM firms").first<any>())!.id;
    await env.CONTROL.prepare("INSERT INTO users (id, firm_id, email, role, created_at) VALUES (?, ?, 'staff@firm.test', 'member', ?)").bind(randomId(), firmId, Date.now()).run();
    const staff = await login("staff@firm.test");
    const hold = (cookie: string, on: boolean) => api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on } });
    expect((await hold(staff, true)).status).toBe(200);
    expect((await hold(staff, false)).status).toBe(403);
    expect((await row()).hold_at).toBeGreaterThan(0);
    expect((await hold(cookie, false)).status).toBe(200);
    expect((await row()).hold_at).toBeNull();
  });
});

describe("retention impact", () => {
  it("counts the requests a shorter period would retire, not held or still live ones", async () => {
    const { cookie, req } = await openRequest();
    const other = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: req.client_id, title: "B", deadline: Date.now() + 86_400_000 } })).json<any>();
    const third = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: req.client_id, title: "C", deadline: Date.now() + 86_400_000 } })).json<any>();
    for (const id of [req.id, other.id, third.id]) await api(`/api/requests/${id}/close`, { method: "POST", cookie });
    await api(`/api/requests/${third.id}/hold`, { method: "PUT", cookie, body: { on: true } });
    await env.DB_NA.prepare("UPDATE requests SET ended_at = ? WHERE id IN (?, ?)").bind(Date.now() - 3 * 365 * DAY, req.id, third.id).run();
    const count = async (years: number) => (await (await api(`/api/retention/impact?years=${years}`, { cookie })).json<any>()).count;
    expect([await count(1), await count(2), await count(4), await count(7)]).toEqual([1, 1, 0, 0]);
    expect((await api("/api/retention/impact?years=0", { cookie })).status).toBe(400);
    expect((await api("/api/retention/impact", { cookie })).status).toBe(400);
  });
});
