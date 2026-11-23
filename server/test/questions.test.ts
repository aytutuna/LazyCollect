import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeExpired } from "../src/purge";
import { runReminders } from "../src/reminders";
import { atHour } from "../src/tz";
import { DAY, HOUR, RESTORE_WINDOW } from "../src/util";
import { api, inDays, mockOutbound, pdf, review, setup, upload } from "./helpers";

const TZ = "America/Toronto";

const ITEMS = [
  { label: "Moved in 2025?", kind: "yesno", required: true },
  { label: "Moving receipts", required: true, show_if: { item: 0, value: "yes" } },
  { label: "Employer", kind: "text", required: true },
  { label: "Notes", kind: "longtext", required: false },
  { label: "Dependants", kind: "number", required: false },
  { label: "Move date", kind: "date", required: false, show_if: { item: 0, value: "yes" } },
  { label: "Province", kind: "choice", options: ["ON", "QC", "BC"], required: true },
  { label: "RL-1 slips", required: true, show_if: { item: 6, value: "QC" } },
  { label: "Income", kind: "multi", options: ["Salary", "Rental", "Business"], required: false },
  { label: "Rental records", required: false, show_if: { item: 8, value: "Rental" } },
];

async function make(items: unknown[] = ITEMS) {
  const { cookie, client } = await setup();
  const res = await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "Organizer", deadline: inDays(30), items } });
  const req = await res.json<any>();
  const link = await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>();
  return { cookie, client, req, path: `/api/c/${link.url.split("/c/")[1]}`, res };
}

const answer = (path: string, item: string, value: unknown) => api(`${path}/items/${item}/answer`, { method: "PUT", body: { answer: value } });
const ids = (req: any) => req.items.map((i: any) => i.id);
const seen = async (path: string) => (await (await api(path)).json<any>()).items.map((i: any) => i.label);
const status = async (id: string) => (await env.DB_NA.prepare("SELECT status FROM items WHERE id = ?").bind(id).first<any>())!.status;
const reqStatus = async (id: string) => (await env.DB_NA.prepare("SELECT status FROM requests WHERE id = ?").bind(id).first<any>())!.status;
const stored = async (id: string) => (await env.DB_NA.prepare("SELECT answer FROM items WHERE id = ?").bind(id).first<any>())!.answer;

describe("question items on a request", () => {
  it("creates every kind with its options and condition", async () => {
    const { req, res } = await make();
    expect(res.status).toBe(201);
    expect(req.items.map((i: any) => [i.kind, i.options, i.show_if_pos, i.show_if_value])).toEqual([
      ["yesno", null, null, null],
      ["file", null, 0, "yes"],
      ["text", null, null, null],
      ["longtext", null, null, null],
      ["number", null, null, null],
      ["date", null, 0, "yes"],
      ["choice", ["ON", "QC", "BC"], null, null],
      ["file", null, 6, "QC"],
      ["multi", ["Salary", "Rental", "Business"], null, null],
      ["file", null, 8, "Rental"],
    ]);
    expect(req.items[1].hidden).toBe(true);
    expect(req.items[0].hidden).toBe(false);
  });

  it("refuses bad kinds, options and conditions", async () => {
    const { cookie, client } = await setup();
    const many = Array.from({ length: 21 }, (_, i) => `o${i}`);
    const bad: unknown[][] = [
      [{ label: "A", kind: "radio" }],
      [{ label: "A", kind: "choice" }],
      [{ label: "A", kind: "choice", options: ["one"] }],
      [{ label: "A", kind: "choice", options: ["a", "a"] }],
      [{ label: "A", kind: "choice", options: many }],
      [{ label: "A", kind: "choice", options: ["a", "x".repeat(101)] }],
      [{ label: "A", kind: "text", options: ["a", "b"] }],
      [{ label: "A", options: ["a", "b"] }],
      [{ label: "A", show_if: { item: 0, value: "yes" } }],
      [{ label: "A", kind: "yesno" }, { label: "B", show_if: { item: 1, value: "yes" } }],
      [{ label: "A", kind: "text" }, { label: "B", show_if: { item: 0, value: "yes" } }],
      [{ label: "A", kind: "yesno" }, { label: "B", show_if: { item: 0, value: "maybe" } }],
      [{ label: "A", kind: "choice", options: ["a", "b"] }, { label: "B", show_if: { item: 0, value: "c" } }],
      [{ label: "A", kind: "yesno" }, { label: "B", kind: "yesno", show_if: { item: 0, value: "yes" } }, { label: "C", show_if: { item: 1, value: "yes" } }],
      [{ label: "A", kind: "yesno" }, { label: "B", show_if: { item: -1, value: "yes" } }],
      [{ label: "A", kind: "yesno" }, { label: "B", show_if: { item: 0 } }],
    ];
    for (const items of bad) {
      const res = await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "t", deadline: inDays(5), items } });
      expect([JSON.stringify(items), res.status]).toEqual([JSON.stringify(items), 400]);
    }
    const twenty = Array.from({ length: 20 }, (_, i) => `o${i}`);
    const res = await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "t", deadline: inDays(5), items: [{ label: "A", kind: "multi", options: twenty }] } });
    expect(res.status).toBe(201);
  });

  it("adds a question to an existing request and checks its condition against the items there", async () => {
    const { cookie, req } = await make();
    const add = (body: unknown) => api(`/api/requests/${req.id}/items`, { method: "POST", cookie, body });
    const q = await add({ label: "Anything else?", kind: "yesno" });
    expect(q.status).toBe(201);
    expect(await q.json()).toMatchObject({ kind: "yesno", options: null, answer: null, hidden: false });
    expect((await add({ label: "Details", kind: "text", show_if: { item: 10, value: "yes" } })).status).toBe(201);
    // item 1 is itself conditional, item 2 is a text question, item 99 does not exist
    for (const at of [1, 2, 99]) expect((await add({ label: "x", show_if: { item: at, value: "yes" } })).status).toBe(400);
    expect((await add({ label: "x", kind: "choice", options: ["a"] })).status).toBe(400);
  });

  it("refuses to remove an item that others depend on", async () => {
    const { cookie, req } = await make();
    const gone = await api(`/api/requests/${req.id}/items/${req.items[0].id}`, { method: "DELETE", cookie });
    expect([gone.status, (await gone.json<any>()).error]).toEqual([409, "has_dependents"]);
    expect((await api(`/api/requests/${req.id}/items/${req.items[1].id}`, { method: "DELETE", cookie })).status).toBe(200);
  });

  it("keeps the columns in a firm template and refuses a bad condition there", async () => {
    const { cookie } = await setup();
    const made = await (await api("/api/templates", { method: "POST", cookie, body: { name: "Mine", items: ITEMS } })).json<any>();
    expect(made.items[6]).toMatchObject({ kind: "choice", options: ["ON", "QC", "BC"] });
    expect(made.items[7].show_if).toEqual({ item: 6, value: "QC" });
    const bad = await api(`/api/templates/${made.id}`, { method: "PATCH", cookie, body: { items: [{ label: "A", show_if: { item: 0, value: "yes" } }] } });
    expect(bad.status).toBe(400);
  });

  it("starts a request from a template with its questions", async () => {
    const { cookie, client } = await setup();
    const made = await (await api("/api/templates", { method: "POST", cookie, body: { name: "Mine", items: ITEMS } })).json<any>();
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "t", deadline: inDays(5), template_id: made.id } })).json<any>();
    expect(req.items.map((i: any) => [i.kind, i.show_if_pos])).toEqual(ITEMS.map((i) => [i.kind ?? "file", i.show_if?.item ?? null]));
  });
});

describe("answers", () => {
  it("validates each kind", async () => {
    const { req, path } = await make();
    const [moved, , employer, notes, dependants, date, province, , income] = ids(req);
    const cases: [string, string, unknown, number][] = [
      ["yesno", moved, "yes", 200], ["yesno", moved, "maybe", 400], ["yesno", moved, true, 400],
      ["text", employer, "Acme", 200], ["text", employer, "x".repeat(501), 400], ["text", employer, 5, 400],
      ["longtext", notes, "x".repeat(5000), 200], ["longtext", notes, "x".repeat(5001), 400],
      ["number", dependants, 2, 200], ["number", dependants, "2.5", 200], ["number", dependants, "-3", 200],
      ["number", dependants, "two", 400], ["number", dependants, "1e5", 400], ["number", dependants, "1".repeat(20), 400],
      ["choice", province, "QC", 200], ["choice", province, "NS", 400], ["choice", province, ["QC"], 400],
      ["multi", income, ["Salary", "Rental"], 200], ["multi", income, ["Salary", "Salary"], 400], ["multi", income, ["Gold"], 400], ["multi", income, "Salary", 400],
    ];
    for (const [kind, id, value, want] of cases) expect([kind, value, (await answer(path, id, value)).status]).toEqual([kind, value, want]);
    // the date question is only shown once the first one says yes
    await answer(path, moved, "yes");
    expect((await answer(path, date, "2025-06-30")).status).toBe(200);
    for (const value of ["2025-02-30", "30/06/2025", "1850-01-01"]) expect((await answer(path, date, value)).status).toBe(400);
  });

  it("reads a comma as decimals only, and refuses thousands separators", async () => {
    const { req, path } = await make();
    const dependants = ids(req)[4];
    for (const [value, want, saved] of [["12,5", 200, "12.5"], ["7,25", 200, "7.25"], ["1,000", 400, "7.25"], ["12,345.50", 400, "7.25"], ["1,2345", 400, "7.25"], ["1000", 200, "1000"]] as const) {
      expect([value, (await answer(path, dependants, value)).status]).toEqual([value, want]);
      expect(await stored(dependants)).toBe(saved);
    }
  });

  it("stores the answer, marks the item answered and clears it again", async () => {
    const { req, path } = await make();
    const [, , employer, , dependants, , , , income] = ids(req);
    expect((await answer(path, employer, "  Acme  ")).status).toBe(200);
    expect(await status(employer)).toBe("submitted");
    const items = (await (await answer(path, income, ["Rental"])).json<any>()).items;
    expect(items.find((i: any) => i.id === employer)).toMatchObject({ answer: "Acme", status: "submitted" });
    expect(items.find((i: any) => i.id === income).answer).toEqual(["Rental"]);
    await answer(path, dependants, 3);
    expect(await stored(dependants)).toBe("3");
    await answer(path, employer, "");
    expect(await status(employer)).toBe("empty");
    expect(await stored(employer)).toBeNull();
  });

  it("shows and hides conditional items as the parent is answered", async () => {
    const { req, path } = await make();
    const [moved, , , , , , province] = ids(req);
    expect(await seen(path)).not.toContain("Moving receipts");
    expect(await seen(path)).not.toContain("Move date");
    const shown = (await (await answer(path, moved, "yes")).json<any>()).items.map((i: any) => i.label);
    expect(shown).toEqual(expect.arrayContaining(["Moving receipts", "Move date"]));
    const hidden = (await (await answer(path, moved, "no")).json<any>()).items.map((i: any) => i.label);
    expect(hidden).not.toContain("Moving receipts");
    await answer(path, province, "QC");
    expect(await seen(path)).toContain("RL-1 slips");
    await answer(path, province, "ON");
    expect(await seen(path)).not.toContain("RL-1 slips");
  });

  it("shows a multiple choice item's dependants for any chosen option", async () => {
    const { req, path } = await make();
    const income = ids(req)[8];
    await answer(path, income, ["Salary", "Rental"]);
    expect(await seen(path)).toContain("Rental records");
    await answer(path, income, ["Salary"]);
    expect(await seen(path)).not.toContain("Rental records");
  });

  it("refuses hidden items, file items and approved answers", async () => {
    const { cookie, req, path } = await make();
    const [moved, receipts, employer, , , date] = ids(req);
    expect((await answer(path, receipts, "x")).status).toBe(404);
    expect((await answer(path, date, "2025-01-01")).status).toBe(409);
    await answer(path, moved, "no");
    expect((await answer(path, date, "2025-01-01")).status).toBe(409);
    await answer(path, employer, "Acme");
    const at = (await env.DB_NA.prepare("SELECT answer_at FROM items WHERE id = ?").bind(employer).first<any>())!.answer_at;
    await review(cookie, req.id, employer, { decision: "approve", answered_at: at });
    expect((await answer(path, employer, "Other")).status).toBe(409);
    expect(await stored(employer)).toBe("Acme");
  });

  it("is scoped to the link", async () => {
    const a = await make();
    const b = await make();
    expect((await answer(b.path, a.req.items[0].id, "yes")).status).toBe(404);
    expect((await answer(`/api/c/na_${"x".repeat(43)}`, a.req.items[0].id, "yes")).status).toBe(404);
    expect((await answer("/api/c/nonsense", a.req.items[0].id, "yes")).status).toBe(404);
    expect((await answer(a.path, a.req.items[0].id, "yes")).status).toBe(200);
  });

  it("is refused on a closed, expired or replaced link", async () => {
    const closed = await make();
    await api(`/api/requests/${closed.req.id}/close`, { method: "POST", cookie: closed.cookie });
    expect((await answer(closed.path, closed.req.items[0].id, "yes")).status).toBe(404);

    const expired = await make();
    await env.DB_NA.prepare("UPDATE links SET expires_at = ? WHERE request_id = ?").bind(Date.now() - 1, expired.req.id).run();
    expect((await answer(expired.path, expired.req.items[0].id, "yes")).status).toBe(404);

    const replaced = await make();
    await api(`/api/requests/${replaced.req.id}/link`, { method: "POST", cookie: replaced.cookie });
    expect((await answer(replaced.path, replaced.req.items[0].id, "yes")).status).toBe(404);
  });

  it("is rate limited", async () => {
    const { req, path } = await make();
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) statuses.push((await answer(path, req.items[2].id, `a${i}`)).status);
    expect(statuses[0]).toBe(200);
    expect(statuses).toContain(429);
  });

  it("does not take an upload on a question or a don't-have on one", async () => {
    const { req, path } = await make();
    expect((await upload(path, req.items[2].id, pdf(100))).status).toBe(404);
    expect((await api(`${path}/items/${req.items[2].id}/unavailable`, { method: "POST", body: {} })).status).toBe(409);
  });

  it("keeps the answer out of the audit log", async () => {
    const { req, path } = await make();
    await answer(path, req.items[2].id, "Secret Employer Ltd");
    const rows = (await env.DB_NA.prepare("SELECT action, meta FROM audit WHERE action = 'item.answer'").all<any>()).results;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("Secret");
  });
});

describe("completion", () => {
  const two = [
    { label: "Moved?", kind: "yesno", required: true },
    { label: "Receipts", required: true, show_if: { item: 0, value: "yes" } },
    { label: "Notes", kind: "text", required: false },
  ];

  it("counts a required answered question as received, so a request of questions completes", async () => {
    const { req, path } = await make(two);
    expect(await reqStatus(req.id)).toBe("open");
    await answer(path, req.items[0].id, "no");
    expect(await reqStatus(req.id)).toBe("complete");
    await answer(path, req.items[0].id, "");
    expect(await reqStatus(req.id)).toBe("open");
  });

  it("does not count a hidden required item as missing, and does once it is shown", async () => {
    const { req, path } = await make(two);
    await answer(path, req.items[0].id, "yes");
    expect(await reqStatus(req.id)).toBe("open");
    await answer(path, req.items[0].id, "no");
    expect(await reqStatus(req.id)).toBe("complete");
    await answer(path, req.items[0].id, "yes");
    expect(await reqStatus(req.id)).toBe("open");
    await upload(path, req.items[1].id, pdf(200));
    expect(await reqStatus(req.id)).toBe("complete");
  });

  it("counts only shown items on the dashboard", async () => {
    const { cookie, req, path } = await make(two);
    const row = async () => (await (await api("/api/requests", { cookie })).json<any>()).rows[0];
    const done = async () => (await (await api("/api/requests?view=done", { cookie })).json<any>()).rows.length;
    expect(await row()).toMatchObject({ empty: 2, submitted: 0 });
    await answer(path, req.items[0].id, "yes");
    expect(await row()).toMatchObject({ empty: 2, submitted: 1 });
    expect(await done()).toBe(0);
    await answer(path, req.items[0].id, "no");
    expect(await row()).toMatchObject({ empty: 1, submitted: 1 });
    expect(await done()).toBe(1);
  });

  it("shows the account the answers and which items are hidden", async () => {
    const { cookie, req, path } = await make(two);
    await answer(path, req.items[0].id, "no");
    await answer(path, req.items[2].id, "Hello");
    const detail = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    expect(detail.items.map((i: any) => [i.answer, i.hidden])).toEqual([["no", false], [null, true], ["Hello", false]]);
  });
});

describe("reminders and notices", () => {
  async function remindable() {
    const o = await make([
      { label: "Moved?", kind: "yesno", required: true },
      { label: "Moving receipts", required: true, show_if: { item: 0, value: "yes" } },
      { label: "Employer", kind: "text", required: true },
    ]);
    await api("/api/firm", { method: "PATCH", cookie: o.cookie, body: { address: "12 King St W\nToronto ON M5H 1A1", phone: "416-555-0100" } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    return o;
  }

  // the clock is passed to the cron, so the request is moved to a fixed morning
  const run = async (reqId: string) => {
    const sent = mockOutbound();
    const due = atHour({ y: 2027, m: 1, d: 20 }, 23, TZ);
    const at = atHour({ y: 2027, m: 1, d: 5 }, 10, TZ);
    await env.DB_NA.batch([
      env.DB_NA.prepare("UPDATE requests SET deadline = ?, next_reminder_at = ?, notice_due_at = NULL WHERE id = ?").bind(due, at, reqId),
      env.DB_NA.prepare("UPDATE links SET expires_at = ? WHERE request_id = ?").bind(due + 30 * DAY, reqId),
    ]);
    await runReminders(env, at + 5 * 60_000);
    return sent.filter((m) => m.to.includes("amy@mail.test"));
  };

  it("lists unanswered required questions as missing, never a hidden item or an answered one", async () => {
    const o = await remindable();
    await answer(o.path, o.req.items[0].id, "no");
    const sent = await run(o.req.id);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Employer");
    expect(sent[0].text).not.toContain("Moving receipts");
    expect(sent[0].text).not.toContain("Moved?");
  });

  it("lists a conditional item once its question says yes, and keeps the answer text out", async () => {
    const o = await remindable();
    await answer(o.path, o.req.items[0].id, "yes");
    await answer(o.path, o.req.items[2].id, "Hidden Corp");
    const sent = await run(o.req.id);
    expect(sent[0].text).toContain("Moving receipts");
    expect(sent[0].text).not.toContain("Hidden Corp");
    expect(sent[0].html).not.toContain("Hidden Corp");
  });

  it("does not send a reminder when only a hidden item is left", async () => {
    const o = await remindable();
    await answer(o.path, o.req.items[0].id, "no");
    await answer(o.path, o.req.items[2].id, "Acme");
    expect(await run(o.req.id)).toHaveLength(0);
  });

  it("tells the owner how many questions were answered, without the answers", async () => {
    const o = await remindable();
    await answer(o.path, o.req.items[2].id, "Hidden Corp");
    const sent = mockOutbound();
    await runReminders(env, Date.now() + 2 * HOUR);
    const notice = sent.find((m) => m.to.includes("owner@firm.test"));
    expect(notice?.subject).toContain("answered 1 question");
    expect(JSON.stringify(sent)).not.toContain("Hidden Corp");
  });

  it("sets no notice for a cleared answer", async () => {
    const o = await remindable();
    await answer(o.path, o.req.items[2].id, "");
    expect((await env.DB_NA.prepare("SELECT notice_due_at FROM requests WHERE id = ?").bind(o.req.id).first<any>())!.notice_due_at).toBeNull();
  });

  it("does not count an answer to an item that is hidden by now", async () => {
    const o = await remindable();
    await answer(o.path, o.req.items[2].id, "Acme");
    await env.DB_NA.prepare("UPDATE items SET show_if_pos = 0, show_if_value = 'yes' WHERE id = ?").bind(o.req.items[2].id).run();
    const sent = mockOutbound();
    await runReminders(env, Date.now() + 2 * HOUR);
    expect(sent.filter((m) => m.subject.includes("answered"))).toHaveLength(0);
  });
});

describe("legal hold", () => {
  it("refuses answers on a request on hold", async () => {
    const { cookie, req, path } = await make();
    await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: true } });
    const res = await answer(path, req.items[2].id, "Acme");
    expect([res.status, await res.json()]).toEqual([409, { error: "legal_hold" }]);
    expect(await stored(req.items[2].id)).toBeNull();
    await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: false } });
    expect((await answer(path, req.items[2].id, "Acme")).status).toBe(200);
  });
});

describe("send back", () => {
  const employer = [{ label: "Employer", kind: "text", required: true }];
  const answeredAt = async (id: string) => (await env.DB_NA.prepare("SELECT answer_at FROM items WHERE id = ?").bind(id).first<any>())!.answer_at;

  it("sends an answer back with a note and takes the new answer", async () => {
    const { cookie, req, path } = await make(employer);
    const [id] = ids(req);
    await answer(path, id, "Acme");
    const res = await review(cookie, req.id, id, { decision: "reject", note: "Use the legal name", answered_at: await answeredAt(id) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "rejected", reject_note: "Use the legal name", answer: "Acme" });
    expect(await reqStatus(req.id)).toBe("open");
    expect((await (await api(path)).json<any>()).items[0]).toMatchObject({ status: "rejected", reject_note: "Use the legal name" });
    await answer(path, id, "Acme Inc.");
    expect(await status(id)).toBe("submitted");
  });

  it("approves only the answer the reviewer saw", async () => {
    const { cookie, req, path } = await make(employer);
    const [id] = ids(req);
    await answer(path, id, "Acme");
    const seenAt = await answeredAt(id);
    await env.DB_NA.prepare("UPDATE items SET answer_at = answer_at + 5 WHERE id = ?").bind(id).run();
    expect((await review(cookie, req.id, id, { decision: "approve", answered_at: seenAt })).status).toBe(409);
    expect(await status(id)).toBe("submitted");
    expect((await review(cookie, req.id, id, { decision: "approve", answered_at: seenAt + 5 })).status).toBe(200);
    expect(await status(id)).toBe("approved");
  });

  it("refuses a review of an unanswered question", async () => {
    const { cookie, req } = await make(employer);
    expect((await review(cookie, req.id, req.items[0].id, { decision: "approve" })).status).toBe(409);
  });
});

describe("export and purge", () => {
  it("writes answers.txt with the questions that apply and their answers", async () => {
    const { cookie, req, path } = await make();
    const [moved, , employer, , dependants, , province, , income] = ids(req);
    await answer(path, moved, "no");
    await answer(path, employer, "Acme");
    await answer(path, dependants, 2);
    await answer(path, province, "QC");
    await answer(path, income, ["Salary", "Rental"]);
    await env.DB_NA.prepare("UPDATE items SET status = 'rejected', reject_note = 'Spell it out' WHERE id = ?").bind(employer).run();
    const res = await api(`/api/requests/${req.id}/export`, { cookie });
    expect(res.status).toBe(200);
    const raw = new TextDecoder("latin1").decode(new Uint8Array(await res.arrayBuffer()));
    expect(raw).toContain("answers.txt");
    expect(raw).toContain("Moved in 2025?\n  No\n");
    expect(raw).toContain("Employer\n  Acme\n  sent back: Spell it out\n");
    expect(raw).toContain("Dependants\n  2\n");
    expect(raw).toContain("Province\n  QC\n");
    expect(raw).toContain("Income\n  Salary, Rental\n");
    expect(raw).toContain("Notes\n  no answer\n");
    // hidden by the "no" above
    expect(raw).not.toContain("Move date");
  });

  it("lets a request of questions alone be exported", async () => {
    const { cookie, req } = await make([{ label: "Employer", kind: "text", required: true }]);
    expect((await api(`/api/requests/${req.id}/export`, { cookie })).status).toBe(200);
  });

  it("removes answers with the request on purge", async () => {
    const { cookie, req, path } = await make();
    await answer(path, req.items[2].id, "Acme");
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    const deletedAt = (await env.DB_NA.prepare("SELECT deleted_at FROM requests").first<any>())!.deleted_at;
    await purgeExpired(env, deletedAt + RESTORE_WINDOW);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM items").first<any>())!.n).toBe(0);
    const left = JSON.stringify((await env.DB_NA.prepare("SELECT * FROM audit").all()).results) + JSON.stringify((await env.DB_NA.prepare("SELECT * FROM deletion_log").all()).results);
    expect(left).not.toContain("Acme");
  });
});

describe("migration 0015 on existing rows", () => {
  it("keeps every item as a document and adds the new columns", async () => {
    const { req } = await make([{ label: "Passport", required: true }, { label: "Visa", required: false }]);
    await env.DB_NA.prepare("UPDATE items SET status = 'rejected', reject_note = 'Blurry', reviewed_at = 5 WHERE id = ?").bind(req.items[0].id).run();
    const cols = "id, position, label, help, required, status, reject_note, reviewed_at";
    const before = (await env.DB_NA.prepare(`SELECT ${cols} FROM items ORDER BY position`).all()).results;
    const all = env.TEST_MIGRATIONS_NA as { name: string; queries: string[] }[];
    const run = (prefix: string) => env.DB_NA.batch(all.find((m) => m.name.startsWith(prefix))!.queries.map((q) => env.DB_NA.prepare(q)));

    // back to the shape before 0015 (0014 rebuilds the table), then forward again
    await env.DB_NA.prepare("DROP TABLE notes").run();
    await run("0014");
    expect((await env.DB_NA.prepare("SELECT name FROM pragma_table_info('items') WHERE name = 'kind'").all()).results).toEqual([]);
    await run("0015");

    expect((await env.DB_NA.prepare(`SELECT ${cols} FROM items ORDER BY position`).all()).results).toEqual(before);
    const row = await env.DB_NA.prepare("SELECT kind, options_json, show_if_pos, show_if_value, answer, answer_at FROM items WHERE id = ?").bind(req.items[0].id).first<any>();
    expect(row).toEqual({ kind: "file", options_json: null, show_if_pos: null, show_if_value: null, answer: null, answer_at: null });
    const names = (await env.DB_NA.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'items'").all<any>()).results.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["idx_items_request", "idx_items_scope", "idx_items_summary"]));
    expect((await env.DB_NA.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await expect(env.DB_NA.prepare("UPDATE items SET kind = 'radio' WHERE id = ?").bind(req.items[0].id).run()).rejects.toThrow();
  });
});
