import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runBatches } from "../src/batches";
import { nextYearTitle } from "../src/copy";
import { atHour, plusYear } from "../src/tz";
import { DAY, MINUTE, randomId } from "../src/util";
import { api, inDays, mockOutbound, openRequest, pdf, setup, upload } from "./helpers";

const TZ = "America/Toronto";
const at = (y: number, m: number, d: number, h: number, min = 0) => atHour({ y, m, d }, h, TZ) + min * MINUTE;
const q = <T = any>(sql: string, ...binds: unknown[]) => env.DB_NA.prepare(sql).bind(...binds).all<T>().then((r) => r.results);
const repeat = (cookie: string, id: string) => api(`/api/requests/${id}/repeat`, { method: "POST", cookie });

describe("next year's title and deadline", () => {
  it("moves a year between 2000 and 2099 and nothing else", () => {
    expect(nextYearTitle("2025 taxes")).toBe("2026 taxes");
    expect(nextYearTitle("T1 return 2025")).toBe("T1 return 2026");
    expect(nextYearTitle("Tax years 2024-2025")).toBe("Tax years 2025-2026");
    expect(nextYearTitle("FY2025 review")).toBe("FY2026 review");
    expect(nextYearTitle("Study permit")).toBe("Study permit");
    expect(nextYearTitle("Account 120250")).toBe("Account 120250");
    expect(nextYearTitle("Year 1999 and 2100")).toBe("Year 1999 and 2100");
  });

  it("keeps the wall clock time across daylight saving and leap days", () => {
    expect(plusYear(at(2026, 4, 30, 23, 59), TZ)).toBe(at(2027, 4, 30, 23, 59));
    expect(plusYear(at(2026, 12, 31, 23, 59), TZ)).toBe(at(2027, 12, 31, 23, 59));
    expect(plusYear(at(2028, 2, 29, 23, 59), TZ)).toBe(at(2029, 2, 28, 23, 59));
  });
});

describe("repeating one request", () => {
  it("makes a draft for the same client a year on, with the items reset", async () => {
    const { cookie, req, path } = await openRequest();
    const [a] = req.items;
    await upload(path, a.id, pdf(500));
    await api(`/api/requests/${req.id}/notes`, { method: "POST", cookie, body: { body: "hello" } });
    await env.DB_NA.prepare("UPDATE items SET status = 'approved', reviewed_at = 9, reviewed_by = 'u' WHERE id = ?").bind(a.id).run();
    await env.DB_NA.prepare("UPDATE requests SET first_opened_at = 5, hold_at = 7 WHERE id = ?").bind(req.id).run();
    const old = (await q("SELECT deadline, client_id, note FROM requests WHERE id = ?", req.id))[0];

    const res = await repeat(cookie, req.id);
    expect(res.status).toBe(201);
    const made = await res.json<any>();
    expect(made).toMatchObject({ client_id: old.client_id, title: "2026 taxes", note: "Hurry", status: "draft", sent_at: null, first_opened_at: null, hold_at: null, reminders_on: true });
    expect(made.deadline).toBe(plusYear(old.deadline, "America/Toronto"));
    expect(made.items.map((i: any) => [i.label, i.help, i.required, i.status, i.files.length, i.reject_note])).toEqual([
      ["Passport", "All pages", true, "empty", 0, null],
      ["Visa", null, false, "empty", 0, null],
    ]);
    expect(made.items[0].id).not.toBe(a.id);
    expect(await q("SELECT 1 FROM files WHERE request_id = ?", made.id)).toHaveLength(0);
    expect(await q("SELECT 1 FROM notes WHERE request_id = ?", made.id)).toHaveLength(0);
    expect(await q("SELECT 1 FROM links WHERE request_id = ?", made.id)).toHaveLength(0);
    const source = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    expect(source.items[0]).toMatchObject({ status: "approved" });
    expect(source.items[0].files).toHaveLength(1);
    const audit = await q("SELECT action, object_id, meta FROM audit WHERE action = 'request.repeat'");
    expect(audit).toEqual([{ action: "request.repeat", object_id: made.id, meta: JSON.stringify({ from: req.id }) }]);
  });

  it("copies an item column added later without it being named in the code", async () => {
    await env.DB_NA.prepare("ALTER TABLE items ADD COLUMN kind TEXT").run();
    try {
      const { cookie, req } = await openRequest();
      await env.DB_NA.prepare("UPDATE items SET kind = 'question' WHERE id = ?").bind(req.items[1].id).run();
      const made = await (await repeat(cookie, req.id)).json<any>();
      expect((await q("SELECT label, kind FROM items WHERE request_id = ? ORDER BY position", made.id))).toEqual([
        { label: "Passport", kind: null },
        { label: "Visa", kind: "question" },
      ]);
    } finally {
      await env.DB_NA.prepare("ALTER TABLE items DROP COLUMN kind").run();
    }
  });

  it("works on a closed request and keeps a title without a year", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { title: "Study permit" } });
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    const made = await (await repeat(cookie, req.id)).json<any>();
    expect(made).toMatchObject({ title: "Study permit", status: "draft" });
  });

  it("refuses a deleted request and another account's request", async () => {
    const { cookie, req } = await openRequest("a@firm.test");
    const other = await setup("b@firm.test");
    expect((await repeat(other.cookie, req.id)).status).toBe(404);
    expect((await repeat(cookie, randomId())).status).toBe(404);
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    expect((await repeat(cookie, req.id)).status).toBe(404);
    expect((await q("SELECT COUNT(*) AS n FROM requests"))[0].n).toBe(1);
  });

  it("refuses when the client has been deleted", async () => {
    const { cookie, req } = await openRequest();
    const clientId = (await q("SELECT client_id FROM requests WHERE id = ?", req.id))[0].client_id;
    await api(`/api/clients/${clientId}`, { method: "DELETE", cookie });
    const res = await repeat(cookie, req.id);
    expect([res.status, (await res.json<any>()).error]).toEqual([409, "client_deleted"]);
    expect((await q("SELECT COUNT(*) AS n FROM requests"))[0].n).toBe(1);
  });

  it("counts toward the 300 requests a day", async () => {
    const { cookie, req } = await openRequest();
    await env.DB_NA.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 299)
       INSERT INTO requests (id, firm_id, client_id, title, deadline, created_by, created_at)
       SELECT lower(hex(randomblob(16))), firm_id, client_id, 'f', 1, 'u', ? FROM n, (SELECT firm_id, client_id FROM requests LIMIT 1)`,
    )
      .bind(Date.now())
      .run();
    const res = await repeat(cookie, req.id);
    expect([res.status, (await res.json<any>()).error]).toEqual([429, "too_many_requests"]);
    expect((await q("SELECT COUNT(*) AS n FROM requests"))[0].n).toBe(300);
  });
});

describe("repeating many requests", () => {
  async function prepared() {
    const { cookie, req } = await openRequest();
    await api("/api/firm", { method: "PATCH", cookie, body: { address: "12 King St W\nToronto ON M5H 1A1" } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active', stripe_subscription_id = 'sub_1'").run();
    const second = await (await api("/api/clients", { method: "POST", cookie, body: { name: "Bea", email: "bea@mail.test", contact_ok: true } })).json<any>();
    const other = await (
      await api("/api/requests", { method: "POST", cookie, body: { client_id: second.id, title: "2025 taxes", deadline: inDays(10), items: [{ label: "Her slip", required: true }] } })
    ).json<any>();
    // a year ago relative to the repeat
    await env.DB_NA.prepare("UPDATE requests SET deadline = ?").bind(at(2027, 4, 30, 23, 59)).run();
    return { cookie, ids: [req.id, other.id] };
  }

  it("makes a batch with each client's own copy and a year on", async () => {
    const { cookie, ids } = await prepared();
    await env.DB_NA.prepare("UPDATE items SET label = 'Passport (new)' WHERE request_id = ? AND position = 0").bind(ids[0]).run();
    const res = await api("/api/batches", { method: "POST", cookie, body: { request_ids: ids, title: "Repeat 2025", reminders_on: false } });
    expect(res.status).toBe(201);
    const batch = await res.json<any>();
    expect(batch).toMatchObject({ source_kind: "repeat", total: 2, pending: 2, deadline: null, reminders_on: false });
    const made = await q("SELECT r.id, r.title, r.deadline, r.status, r.reminders_on, c.name FROM requests r JOIN clients c ON c.id = r.client_id JOIN batch_items i ON i.request_id = r.id ORDER BY c.name");
    expect(made.map((r) => [r.name, r.title, r.deadline, r.status, r.reminders_on])).toEqual([
      ["Amy", "2026 taxes", at(2028, 4, 30, 23, 59), "draft", 0],
      ["Bea", "2026 taxes", at(2028, 4, 30, 23, 59), "draft", 0],
    ]);
    expect((await q("SELECT label FROM items WHERE request_id = ? ORDER BY position", made[0].id)).map((i) => i.label)).toEqual(["Passport (new)", "Visa"]);
    expect((await q("SELECT label FROM items WHERE request_id = ?", made[1].id)).map((i) => i.label)).toEqual(["Her slip"]);
    expect((await q("SELECT COUNT(*) AS n FROM requests"))[0].n).toBe(4);
    expect((await q("SELECT meta FROM audit WHERE action = 'batch.create'")).map((a) => JSON.parse(a.meta).kind)).toEqual(["repeat"]);
  });

  it("sends the copies like any batch", async () => {
    const { cookie, ids } = await prepared();
    const sent = mockOutbound();
    await api("/api/batches", { method: "POST", cookie, body: { request_ids: ids, title: "Repeat 2025", reminders_on: true } });
    await runBatches(env, at(2027, 1, 12, 10));
    expect(sent.map((m) => m.subject).sort()).toEqual(["Documents requested: 2026 taxes", "Documents requested: 2026 taxes"]);
    expect((await q("SELECT status FROM batches"))[0].status).toBe("done");
  });

  it("refuses the whole batch when a new deadline would already be past", async () => {
    const { cookie, ids } = await prepared();
    await env.DB_NA.prepare("UPDATE requests SET deadline = ? WHERE id = ?").bind(Date.now() - 400 * DAY, ids[1]).run();
    const res = await api("/api/batches", { method: "POST", cookie, body: { request_ids: ids, title: "Repeat", reminders_on: true } });
    expect([res.status, (await res.json<any>()).error]).toEqual([400, "deadline_passed"]);
    expect((await q("SELECT COUNT(*) AS n FROM requests"))[0].n).toBe(2);
    expect(await q("SELECT 1 FROM batches")).toHaveLength(0);
  });

  it("refuses requests that are unknown, deleted or another account's", async () => {
    const { cookie, ids } = await prepared();
    const other = await setup("b@firm.test");
    await api("/api/firm", { method: "PATCH", cookie: other.cookie, body: { address: "1 Main St" } });
    expect((await api("/api/batches", { method: "POST", cookie: other.cookie, body: { request_ids: ids, title: "x", reminders_on: true } })).status).toBe(404);
    expect((await api("/api/batches", { method: "POST", cookie, body: { request_ids: [ids[0], randomId()], title: "x", reminders_on: true } })).status).toBe(404);
    await api(`/api/requests/${ids[1]}`, { method: "DELETE", cookie });
    expect((await api("/api/batches", { method: "POST", cookie, body: { request_ids: ids, title: "x", reminders_on: true } })).status).toBe(404);
    expect(await q("SELECT 1 FROM batches")).toHaveLength(0);
  });
});
