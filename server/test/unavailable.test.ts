import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runReminders } from "../src/reminders";
import { addDays, atHour, dayOf } from "../src/tz";
import { HOUR, MINUTE, randomId } from "../src/util";
import { addMember, api, mockOutbound, openRequest, pdf, restoreItemColumns, setup, upload } from "./helpers";

const TZ = "America/Toronto";
const ADDRESS = "12 King St W\nToronto ON M5H 1A1";

const mark = (path: string, item: string, body: unknown = {}) => api(`${path}/items/${item}/unavailable`, { method: "POST", body });
const unmark = (path: string, item: string) => api(`${path}/items/${item}/unavailable`, { method: "DELETE" });
const decide = (cookie: string, req: string, item: string, body: unknown) => api(`/api/requests/${req}/items/${item}/unavailable`, { method: "POST", cookie, body });
const status = async (id: string) => (await env.DB_NA.prepare("SELECT status FROM items WHERE id = ?").bind(id).first<any>())!.status;
const request = (id: string) => env.DB_NA.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first<any>();
const audits = async () => (await env.DB_NA.prepare("SELECT action, actor_type FROM audit ORDER BY rowid").all<any>()).results.map((r) => `${r.actor_type}:${r.action}`);

describe("client says they do not have a document", () => {
  it("marks an item with a reason and shows it to the account", async () => {
    const { cookie, req, path } = await openRequest();
    const [passport] = req.items.map((i: any) => i.id);
    const res = await mark(path, passport, { note: "Lost it in a move" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: passport, status: "unavailable" });

    const seen = await (await api(path)).json<any>();
    expect(seen.items[0]).toMatchObject({ status: "unavailable", unavailable_note: "Lost it in a move" });
    const detail = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    expect(detail.items[0]).toMatchObject({ status: "unavailable", unavailable_note: "Lost it in a move" });
    expect(await audits()).toContain("client:item.unavailable");
  });

  it("takes the reason as optional and at most 500 characters", async () => {
    const { req, path } = await openRequest();
    const [passport, visa] = req.items.map((i: any) => i.id);
    expect((await mark(path, passport)).status).toBe(200);
    expect((await env.DB_NA.prepare("SELECT unavailable_note FROM items WHERE id = ?").bind(passport).first<any>())!.unavailable_note).toBeNull();
    for (const note of ["x".repeat(501), 5, ["a"]]) expect([note, (await mark(path, visa, { note })).status]).toEqual([note, 400]);
    expect((await mark(path, visa, { note: "x".repeat(500) })).status).toBe(200);
  });

  it("only applies to items that are waiting or were sent back", async () => {
    const { req, path } = await openRequest();
    const [passport, visa] = req.items.map((i: any) => i.id);
    await upload(path, passport, pdf(500));
    expect((await mark(path, passport)).status).toBe(409);
    await env.DB_NA.prepare("UPDATE items SET status = 'approved' WHERE id = ?").bind(passport).run();
    expect((await mark(path, passport)).status).toBe(409);
    expect((await mark(path, "0".repeat(32))).status).toBe(404);
    expect((await mark(path.replace(/\/c\/.*/, "/c/na_" + "a".repeat(43)), visa)).status).toBe(404);
    await env.DB_NA.prepare("UPDATE items SET status = 'rejected', reject_note = 'Blurry' WHERE id = ?").bind(passport).run();
    expect((await mark(path, passport)).status).toBe(200);
  });

  it("refuses once the request is closed", async () => {
    const { cookie, req, path } = await openRequest();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    expect((await mark(path, req.items[0].id)).status).toBe(404);
  });

  it("can be taken back, and goes back to submitted when files are there", async () => {
    const { req, path } = await openRequest();
    const [passport, visa] = req.items.map((i: any) => i.id);
    await mark(path, passport, { note: "none" });
    expect((await unmark(path, passport)).status).toBe(200);
    expect(await status(passport)).toBe("empty");
    expect((await env.DB_NA.prepare("SELECT unavailable_note FROM items WHERE id = ?").bind(passport).first<any>())!.unavailable_note).toBeNull();
    expect((await unmark(path, passport)).status).toBe(409);

    await upload(path, visa, pdf(500));
    await env.DB_NA.prepare("UPDATE items SET status = 'rejected' WHERE id = ?").bind(visa).run();
    await mark(path, visa);
    await unmark(path, visa);
    expect(await status(visa)).toBe("submitted");
    expect(await audits()).toContain("client:item.available");
  });

  it("is submitted by an upload to the item", async () => {
    const { req, path } = await openRequest();
    const passport = req.items[0].id;
    await mark(path, passport);
    expect((await upload(path, passport, pdf(500))).status).toBe(201);
    expect(await status(passport)).toBe("submitted");
  });

  it("is rate limited per link", async () => {
    const { req, path } = await openRequest();
    const visa = req.items[1].id;
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await mark(path, visa)).status === 429 ? 429 : 0);
    expect(codes).toContain(429);
  });
});

describe("the account answers", () => {
  async function asked() {
    const o = await openRequest();
    const passport = o.req.items[0].id;
    await mark(o.path, passport, { note: "Never had one" });
    return { ...o, passport };
  }

  it("does not count an unanswered item as done", async () => {
    const { req, path } = await openRequest();
    for (const item of req.items) await mark(path, item.id);
    expect((await request(req.id)).status).toBe("open");
  });

  it("accepts it, which counts as done and lets the request complete", async () => {
    const { cookie, req, passport } = await asked();
    const res = await decide(cookie, req.id, passport, { decision: "accept" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: passport, status: "waived", unavailable_note: "Never had one" });
    expect((await request(req.id)).status).toBe("complete");
    expect((await env.DB_NA.prepare("SELECT reviewed_by, reviewed_at FROM items WHERE id = ?").bind(passport).first<any>())!.reviewed_at).toBeGreaterThan(0);
    expect(await audits()).toContain("user:item.waive");
  });

  it("keeps a request open while another required item is missing", async () => {
    const o = await openRequest();
    const [passport, visa] = o.req.items.map((i: any) => i.id);
    await env.DB_NA.prepare("UPDATE items SET required = 1 WHERE id = ?").bind(visa).run();
    await mark(o.path, passport);
    await decide(o.cookie, o.req.id, passport, { decision: "accept" });
    expect((await request(o.req.id)).status).toBe("open");
    await upload(o.path, visa, pdf(500));
    expect((await request(o.req.id)).status).toBe("complete");
  });

  it("treats an upload to a waived item like any other", async () => {
    const { cookie, req, passport, path } = await asked();
    await decide(cookie, req.id, passport, { decision: "accept" });
    expect((await request(req.id)).status).toBe("complete");
    expect((await upload(path, passport, pdf(500))).status).toBe(201);
    expect(await status(passport)).toBe("submitted");
  });

  it("asks again with a note, putting the item back to waiting for the client", async () => {
    const { cookie, req, passport } = await asked();
    for (const body of [{ decision: "ask" }, { decision: "ask", note: " " }, { decision: "ask", note: "x".repeat(501) }, { decision: "maybe" }, {}]) {
      expect([JSON.stringify(body), (await decide(cookie, req.id, passport, body)).status]).toEqual([JSON.stringify(body), 400]);
    }
    const res = await decide(cookie, req.id, passport, { decision: "ask", note: "We need a letter instead" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "rejected", reject_note: "We need a letter instead" });
    expect((await request(req.id)).reject_mark_at).toBeGreaterThan(0);
    expect(await audits()).toContain("user:item.ask_again");
  });

  it("tells the client by email like a sent-back document", async () => {
    const { cookie, req, passport } = await asked();
    await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    const sent = mockOutbound();
    await decide(cookie, req.id, passport, { decision: "ask", note: "We need a letter instead" });
    const day = addDays(dayOf(Date.now(), TZ), 1);
    await env.DB_NA.prepare("UPDATE requests SET reject_mark_at = ?").bind(atHour(day, 10, TZ)).run();
    await runReminders(env, atHour(day, 10, TZ) + 11 * MINUTE);
    const mails = sent.filter((m) => m.subject.startsWith("Please resend"));
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain("Passport (sent back: We need a letter instead)");
  });

  it("only decides on an item that is marked unavailable", async () => {
    const { cookie, req, path } = await openRequest();
    const [passport, visa] = req.items.map((i: any) => i.id);
    expect((await decide(cookie, req.id, passport, { decision: "accept" })).status).toBe(409);
    await mark(path, visa);
    expect((await decide(cookie, req.id, visa, { decision: "accept" })).status).toBe(200);
    expect((await decide(cookie, req.id, visa, { decision: "ask", note: "again" })).status).toBe(409);
    expect((await decide(cookie, req.id, "0".repeat(32), { decision: "accept" })).status).toBe(404);
    expect((await decide(cookie, "0".repeat(32), visa, { decision: "accept" })).status).toBe(404);
  });

  it("is allowed for staff and refused without a session or across accounts", async () => {
    const { cookie, req, passport } = await asked();
    expect((await decide("", req.id, passport, { decision: "accept" })).status).toBe(401);
    const other = await setup("other@firm.test", "Other Tax");
    expect((await decide(other.cookie, req.id, passport, { decision: "accept" })).status).toBe(404);
    expect(await status(passport)).toBe("unavailable");
    const member = await addMember(cookie);
    expect((await decide(member, req.id, passport, { decision: "accept" })).status).toBe(200);
  });

  it("refuses on a closed request", async () => {
    const { cookie, req, passport } = await asked();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    expect((await decide(cookie, req.id, passport, { decision: "accept" })).status).toBe(409);
    expect(await status(passport)).toBe("unavailable");
  });
});

describe("reminders and the owner notice", () => {
  async function ready() {
    const o = await openRequest();
    await api("/api/firm", { method: "PATCH", cookie: o.cookie, body: { address: ADDRESS } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    await env.DB_NA.prepare("UPDATE items SET required = 1").run();
    return o;
  }
  const day = addDays(dayOf(Date.now(), TZ), 3);
  const noon = atHour(day, 11, TZ);
  const due = () => env.DB_NA.prepare("UPDATE requests SET next_reminder_at = ?, notice_due_at = NULL").bind(noon - HOUR).run();

  it("does not ask for an item the client has no document for", async () => {
    const o = await ready();
    const [passport] = o.req.items.map((i: any) => i.id);
    await mark(o.path, passport, { note: "none" });
    await due();
    const sent = mockOutbound();
    await runReminders(env, noon);
    const mail = sent.find((m) => m.subject.startsWith("Reminder"))!;
    expect(mail.text).toContain("Visa");
    expect(mail.text).not.toContain("Passport");
  });

  it("stops the cadence when only unavailable items are left, and starts it again on ask again", async () => {
    const o = await ready();
    const [passport, visa] = o.req.items.map((i: any) => i.id);
    await mark(o.path, passport);
    await mark(o.path, visa);
    await due();
    const sent = mockOutbound();
    await runReminders(env, noon);
    expect(sent.filter((m) => m.subject.startsWith("Reminder"))).toHaveLength(0);
    expect((await request(o.req.id)).next_reminder_at).toBeNull();

    await decide(o.cookie, o.req.id, passport, { decision: "ask", note: "Please look again" });
    expect((await request(o.req.id)).next_reminder_at).toBeGreaterThan(Date.now());
  });

  it("mentions items marked unavailable in the owner notice", async () => {
    const o = await ready();
    await mark(o.path, o.req.items[0].id);
    const sent = mockOutbound();
    await runReminders(env, Date.now() + HOUR);
    const notice = sent.find((m) => m.to[0] === "owner@firm.test")!;
    expect(notice.subject).toBe("Amy said they don't have 1 item on 2025 taxes");
  });
});

describe("home views", () => {
  it("lists a request with an item waiting for an answer under To review, not Waiting", async () => {
    const o = await openRequest();
    await env.DB_NA.prepare("UPDATE items SET required = 1").run();
    const [passport, visa] = o.req.items.map((i: any) => i.id);
    await mark(o.path, passport);
    await mark(o.path, visa);
    const page = async (view: string) => (await (await api(`/api/requests?view=${view}`, { cookie: o.cookie })).json<any>());
    expect((await page("to_review")).rows.map((r: any) => r.id)).toEqual([o.req.id]);
    expect((await page("waiting")).rows).toEqual([]);
    expect((await page("all")).counts).toMatchObject({ to_review: 1, waiting: 0 });

    await decide(o.cookie, o.req.id, passport, { decision: "accept" });
    await decide(o.cookie, o.req.id, visa, { decision: "accept" });
    expect((await page("to_review")).rows).toEqual([]);
    expect((await page("done")).rows.map((r: any) => r.id)).toEqual([o.req.id]);
  });
});

describe("migration 0014 on existing rows", () => {
  it("keeps items, files, messages, indexes and the foreign keys while allowing the new statuses", async () => {
    const o = await openRequest();
    const [passport, visa] = o.req.items.map((i: any) => i.id);
    await upload(o.path, passport, pdf(500));
    await env.DB_NA.prepare("UPDATE items SET status = 'rejected', reject_note = 'Blurry', reviewed_at = 5 WHERE id = ?").bind(passport).run();
    const firm = (await env.DB_NA.prepare("SELECT firm_id, client_id FROM requests").first<any>())!;
    await env.DB_NA
      .prepare("INSERT INTO messages (id, firm_id, request_id, client_id, channel, kind, seq, template_version, body_hash, status, sent_at) VALUES (?, ?, ?, ?, 'email', 'invite', 1, 1, 'h', 'sent', 1)")
      .bind(randomId(), firm.firm_id, o.req.id, firm.client_id)
      .run();
    const before = {
      items: (await env.DB_NA.prepare("SELECT id, position, label, help, required, status, reject_note, reviewed_at FROM items ORDER BY position").all()).results,
      files: (await env.DB_NA.prepare("SELECT id, item_id FROM files").all()).results,
    };

    // the same file again over already migrated data is a rebuild of tables that hold rows; the one table it only creates goes first
    await env.DB_NA.prepare("DROP TABLE notes").run();
    const migration = (env.TEST_MIGRATIONS_NA as { name: string; queries: string[] }[]).find((m) => m.name.startsWith("0014"))!;
    await env.DB_NA.batch(migration.queries.map((q) => env.DB_NA.prepare(q)));
    // the rebuild is back at the 0014 shape; the later columns go on again so the other tests keep their schema
    await restoreItemColumns();

    expect((await env.DB_NA.prepare("SELECT id, position, label, help, required, status, reject_note, reviewed_at FROM items ORDER BY position").all()).results).toEqual(before.items);
    expect((await env.DB_NA.prepare("SELECT id, item_id FROM files").all()).results).toEqual(before.files);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM messages").first<any>())!.n).toBe(1);
    const names = (await env.DB_NA.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('items', 'messages', 'notes')").all<any>()).results.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["idx_items_request", "idx_items_scope", "idx_items_summary", "idx_messages_client", "idx_notes_request"]));
    expect((await env.DB_NA.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

    await env.DB_NA.prepare("UPDATE items SET status = 'unavailable', unavailable_note = 'x' WHERE id = ?").bind(visa).run();
    await env.DB_NA.prepare("UPDATE items SET status = 'waived' WHERE id = ?").bind(visa).run();
    await expect(env.DB_NA.prepare("UPDATE items SET status = 'lost' WHERE id = ?").bind(visa).run()).rejects.toThrow();
    // a file still has to belong to an item
    await expect(
      env.DB_NA
        .prepare("INSERT INTO files (id, firm_id, request_id, item_id, r2_key, name, mime, size, upload_id, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, 'k', 'n', 'm', 1, 'u', 'client', 1)")
        .bind(randomId(), firm.firm_id, o.req.id, randomId())
        .run(),
    ).rejects.toThrow();
  });
});

describe("taking it back", () => {
  it("puts a sent-back item back to sent back, and an item with a newer file to submitted", async () => {
    const { req, path } = await openRequest();
    const [passport, visa] = req.items.map((i: any) => i.id);
    await upload(path, passport, pdf(500));
    await env.DB_NA.prepare("UPDATE items SET status = 'rejected', reject_note = 'Blurry', reviewed_at = ? WHERE id = ?").bind(Date.now() + 1000, passport).run();
    await mark(path, passport);
    await unmark(path, passport);
    expect(await status(passport)).toBe("rejected");

    await upload(path, visa, pdf(500));
    await env.DB_NA.prepare("UPDATE items SET status = 'rejected', reject_note = 'Blurry', reviewed_at = 1 WHERE id = ?").bind(visa).run();
    await mark(path, visa);
    await unmark(path, visa);
    expect(await status(visa)).toBe("submitted");
  });

  it("keeps a request open when a sent-back item is taken back", async () => {
    const o = await openRequest();
    const passport = o.req.items[0].id;
    await upload(o.path, passport, pdf(500));
    await env.DB_NA.prepare("UPDATE items SET status = 'rejected', reject_note = 'Blurry', reviewed_at = ? WHERE id = ?").bind(Date.now() + 1000, passport).run();
    await mark(o.path, passport);
    await unmark(o.path, passport);
    expect((await request(o.req.id)).status).toBe("open");
  });

  it("starts the reminders again", async () => {
    const o = await openRequest();
    const passport = o.req.items[0].id;
    await env.DB_NA.prepare("UPDATE requests SET next_reminder_at = NULL").run();
    await mark(o.path, passport);
    await unmark(o.path, passport);
    expect((await request(o.req.id)).next_reminder_at).toBeGreaterThan(Date.now());
  });
});

describe("export of a request without files", () => {
  it("lists the unavailable items and their reasons in checklist.txt", async () => {
    const o = await openRequest();
    const [passport, visa] = o.req.items.map((i: any) => i.id);
    await mark(o.path, passport, { note: "Lost in a move" });
    await mark(o.path, visa);
    await decide(o.cookie, o.req.id, visa, { decision: "ask", note: "Please look again" });
    const res = await api(`/api/requests/${o.req.id}/export`, { cookie: o.cookie });
    expect(res.status).toBe(200);
    const raw = new TextDecoder("latin1").decode(new Uint8Array(await res.arrayBuffer()));
    expect(raw).toContain("checklist.txt");
    expect(raw).toContain("Passport\n  client says they do not have it, waiting for an answer\n  client's reason: Lost in a move");
    expect(raw).toContain("Visa\n  asked again: Please look again");
  });

  it("still refuses when there is nothing at all", async () => {
    const o = await openRequest();
    expect((await api(`/api/requests/${o.req.id}/export`, { cookie: o.cookie })).status).toBe(409);
  });
});
