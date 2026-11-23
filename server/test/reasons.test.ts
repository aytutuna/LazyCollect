import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeExpired } from "../src/purge";
import { REASONS } from "../src/reasons";
import { runReminders } from "../src/reminders";
import { addDays, atHour, dayOf } from "../src/tz";
import { MINUTE } from "../src/util";
import { api, inDays, mockOutbound, openRequest, pdf, review, setup, upload } from "./helpers";

const TZ = "America/Toronto";

async function submitted() {
  const o = await openRequest();
  const item = o.req.items[0].id;
  const file = await (await upload(o.path, item, pdf(2000), { name: "a.pdf" })).json<any>();
  return { ...o, item, file };
}

const answeredAt = async (id: string) => (await env.DB_NA.prepare("SELECT answer_at FROM items WHERE id = ?").bind(id).first<any>())!.answer_at;
const row = async (id: string) => (await env.DB_NA.prepare("SELECT status, reject_note, reject_reasons FROM items WHERE id = ?").bind(id).first<any>())!;

async function questions() {
  const { cookie, client } = await setup();
  const items = [
    { label: "Employer", kind: "text", required: true },
    { label: "Tax year", kind: "text", required: true },
    { label: "Spouse", kind: "text", required: true },
  ];
  const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "Organizer", deadline: inDays(30), items } })).json<any>();
  const link = await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>();
  const path = `/api/c/${link.url.split("/c/")[1]}`;
  for (const i of req.items) await api(`${path}/items/${i.id}/answer`, { method: "PUT", body: { answer: "x" } });
  return { cookie, req, path };
}

describe("send-back reasons", () => {
  it("stores the codes next to the note", async () => {
    const { cookie, req, item } = await submitted();
    const res = await review(cookie, req.id, item, { decision: "reject", reasons: ["blurry", "glare"], note: "Page 2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "rejected", reject_reasons: ["blurry", "glare"], reject_note: "Page 2" });
    expect(await row(item)).toEqual({ status: "rejected", reject_note: "Page 2", reject_reasons: '["blurry","glare"]' });
    const audit = (await env.DB_NA.prepare("SELECT meta FROM audit WHERE action = 'item.review'").first<any>())!;
    expect(JSON.parse(audit.meta)).toEqual({ request: req.id, decision: "reject", reasons: ["blurry", "glare"] });
  });

  it("accepts every reason on a document, with no note", async () => {
    const { cookie, req, item } = await submitted();
    const all = Object.keys(REASONS).filter((r) => r !== "other");
    expect((await review(cookie, req.id, item, { decision: "reject", reasons: all })).status).toBe(200);
    expect(JSON.parse((await row(item)).reject_reasons)).toEqual(all);
  });

  it("refuses a document without a reason, an unknown or repeated one, and other without a note", async () => {
    const { cookie, req, item } = await submitted();
    const bad: Record<string, unknown>[] = [
      { reasons: [] },
      { reasons: [], note: "just a note" },
      { reasons: ["smudged"] },
      { reasons: ["blurry", "blurry"] },
      { reasons: "blurry" },
      { reasons: [5] },
      { reasons: ["other"] },
      { reasons: ["other"], note: "  " },
      { reasons: Array(12).fill("blurry") },
    ];
    for (const body of bad) expect([JSON.stringify(body), (await review(cookie, req.id, item, { decision: "reject", ...body })).status]).toEqual([JSON.stringify(body), 400]);
    expect((await row(item)).status).toBe("submitted");
    expect((await review(cookie, req.id, item, { decision: "reject", reasons: ["other"], note: "Not ours" })).status).toBe(200);
  });

  it("clears them on approval", async () => {
    const { cookie, req, item } = await submitted();
    await review(cookie, req.id, item, { decision: "reject", reasons: ["dark"] });
    await env.DB_NA.prepare("UPDATE items SET status = 'submitted'").run();
    expect((await review(cookie, req.id, item, { decision: "approve", reasons: ["dark"] })).status).toBe(200);
    expect(await row(item)).toEqual({ status: "approved", reject_note: null, reject_reasons: null });
  });

  it("lets a question go back with a note or the reasons that fit it", async () => {
    const { cookie, req } = await questions();
    const [employer, year, spouse] = req.items.map((i: any) => i.id);
    const send = async (id: string, body: Record<string, unknown>) => review(cookie, req.id, id, { decision: "reject", answered_at: await answeredAt(id), ...body });
    expect((await send(employer, { reasons: [] })).status).toBe(400);
    expect((await send(employer, { reasons: ["blurry"], note: "n" })).status).toBe(400);
    expect((await send(employer, { reasons: [], note: "Use the legal name" })).status).toBe(200);
    expect((await send(year, { reasons: ["wrong_period"] })).status).toBe(200);
    expect((await send(spouse, { reasons: ["wrong_person", "other"], note: "Not the spouse" })).status).toBe(200);
    expect((await row(employer)).reject_reasons).toBeNull();
    expect((await row(year)).reject_reasons).toBe('["wrong_period"]');
  });

  it("is cleared when the account asks again for an item the client does not have", async () => {
    const { cookie, req, item, path } = await submitted();
    await review(cookie, req.id, item, { decision: "reject", reasons: ["expired"] });
    await api(`${path}/items/${item}/unavailable`, { method: "POST", body: { note: "Lost it" } });
    await api(`/api/requests/${req.id}/items/${item}/unavailable`, { method: "POST", cookie, body: { decision: "ask", note: "Please look again" } });
    expect(await row(item)).toMatchObject({ status: "rejected", reject_note: "Please look again", reject_reasons: null });
  });
});

describe("which file was sent back", () => {
  it("marks the files live at review and shows them to the client and the account", async () => {
    const { cookie, req, item, path, file } = await submitted();
    await review(cookie, req.id, item, { decision: "reject", reasons: ["cut_off"] });
    const mark = (await env.DB_NA.prepare("SELECT sent_back_at FROM files WHERE id = ?").bind(file.id).first<any>())!.sent_back_at;
    expect(mark).toBeGreaterThan(0);

    const view = await (await api(path)).json<any>();
    expect(view.items[0]).toMatchObject({ status: "rejected", reject_reasons: ["cut_off"] });
    expect(view.items[0].files).toEqual([{ id: file.id, name: "a.pdf", size: 2000, uploaded_at: file.uploaded_at, sent_back_at: mark }]);

    const newer = await (await upload(path, item, pdf(3000), { name: "b.pdf" })).json<any>();
    const after = await (await api(path)).json<any>();
    expect(after.items[0].files.map((f: any) => [f.name, f.sent_back_at])).toEqual([["a.pdf", mark], ["b.pdf", null]]);
    const detail = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    expect(detail.items[0].files.map((f: any) => [f.id, f.sent_back_at])).toEqual([[file.id, mark], [newer.id, null]]);
    expect(detail.items[0].reject_reasons).toEqual(["cut_off"]);
  });

  it("keeps the first mark when a later file is sent back too", async () => {
    const { cookie, req, item, path, file } = await submitted();
    await review(cookie, req.id, item, { decision: "reject", reasons: ["glare"] });
    const first = (await env.DB_NA.prepare("SELECT sent_back_at FROM files WHERE id = ?").bind(file.id).first<any>())!.sent_back_at;
    const newer = await (await upload(path, item, pdf(500), { name: "b.pdf" })).json<any>();
    await new Promise((r) => setTimeout(r, 3));
    await review(cookie, req.id, item, { decision: "reject", reasons: ["dark"] });
    const marks = (await env.DB_NA.prepare("SELECT id, sent_back_at FROM files").all<any>()).results;
    expect(marks.find((m) => m.id === file.id).sent_back_at).toBe(first);
    expect(marks.find((m) => m.id === newer.id).sent_back_at).toBeGreaterThan(first);
  });

  it("marks nothing on approval", async () => {
    const { cookie, req, item } = await submitted();
    await review(cookie, req.id, item, { decision: "approve" });
    expect((await env.DB_NA.prepare("SELECT sent_back_at FROM files").first<any>())!.sent_back_at).toBeNull();
  });
});

describe("the sent-back email", () => {
  it("lists the reason labels and notes per item, and nothing from the files", async () => {
    const o = await openRequest();
    await api("/api/firm", { method: "PATCH", cookie: o.cookie, body: { address: "12 King St W\nToronto ON M5H 1A1" } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    const [passport, visa] = o.req.items.map((i: any) => i.id);
    for (const id of [passport, visa]) await upload(o.path, id, pdf(500), { name: "secret-name.pdf" });
    await review(o.cookie, o.req.id, passport, { decision: "reject", reasons: ["blurry", "wrong_period"], note: "Page 2" });
    await review(o.cookie, o.req.id, visa, { decision: "reject", reasons: ["other"], note: "Not a visa" });
    const sent = mockOutbound();
    const day = addDays(dayOf(Date.now(), TZ), 1);
    await env.DB_NA.prepare("UPDATE requests SET reject_mark_at = ?").bind(atHour(day, 10, TZ)).run();
    await runReminders(env, atHour(day, 10, TZ) + 11 * MINUTE);
    const mail = sent.find((m) => m.subject.startsWith("Please resend"))!;
    expect(mail.text).toContain("Passport (sent back: blurry or hard to read; wrong year or period; Page 2)");
    expect(mail.text).toContain("Visa (sent back: Not a visa)");
    expect(mail.html).toContain("Passport (sent back: blurry or hard to read; wrong year or period; Page 2)");
    expect(mail.text).not.toContain("secret-name");
  });
});

describe("export, activity and purge", () => {
  // the archive stores its entries uncompressed, so the text can be read straight out of the bytes
  const archive = async (res: Response) => new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));

  it("writes the reasons into checklist.txt and answers.txt", async () => {
    const { cookie, req } = await questions();
    const [employer, year] = req.items.map((i: any) => i.id);
    await review(cookie, req.id, employer, { decision: "reject", reasons: [], note: "Use the legal name", answered_at: await answeredAt(employer) });
    await review(cookie, req.id, year, { decision: "reject", reasons: ["wrong_period"], answered_at: await answeredAt(year) });
    const text = await archive(await api(`/api/requests/${req.id}/export`, { cookie }));
    expect(text).toContain("Employer\n  x\n  sent back: Use the legal name\n");
    expect(text).toContain("Tax year\n  x\n  sent back: wrong year or period\n");
  });

  it("lists a sent-back document in checklist.txt without a client's reason", async () => {
    const { cookie, req, item } = await submitted();
    await review(cookie, req.id, item, { decision: "reject", reasons: ["glare", "other"], note: "Flash on the photo" });
    const text = await archive(await api(`/api/requests/${req.id}/export`, { cookie }));
    expect(text).toContain("Passport\n  sent back: glare or shadow; Flash on the photo\n");
    expect(text).not.toContain("no reason given");
  });

  it("shows the reasons on the request's activity and the account's", async () => {
    const { cookie, req, item } = await submitted();
    await review(cookie, req.id, item, { decision: "reject", reasons: ["wrong_document", "pages_missing"] });
    for (const path of [`/api/requests/${req.id}/activity`, "/api/activity"]) {
      const rows = (await (await api(path, { cookie })).json<any>()).rows;
      expect(rows.find((r: any) => r.action === "item.review")).toMatchObject({ decision: "reject", reasons: ["wrong_document", "pages_missing"] });
    }
  });

  it("removes the reasons with the request and keeps the rest of the audit row", async () => {
    const { cookie, req, item } = await submitted();
    await review(cookie, req.id, item, { decision: "reject", reasons: ["blurry"], note: "Page 2" });
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1").run();
    await purgeExpired(env, Date.now());
    expect(await env.DB_NA.prepare("SELECT 1 FROM items").first()).toBeNull();
    const meta = (await env.DB_NA.prepare("SELECT meta FROM audit WHERE action = 'item.review'").first<any>())!.meta;
    expect(JSON.parse(meta)).toEqual({ request: req.id, decision: "reject" });
  });
});

describe("migration 0020 on existing rows", () => {
  it("leaves items and files as they were and adds the new columns empty", async () => {
    const { cookie, req, item, file } = await submitted();
    await review(cookie, req.id, item, { decision: "reject", reasons: ["blurry"], note: "Old note" });
    await env.DB_NA.batch([
      env.DB_NA.prepare("DROP INDEX idx_items_example"),
      env.DB_NA.prepare("ALTER TABLE items DROP COLUMN reject_reasons"),
      env.DB_NA.prepare("ALTER TABLE items DROP COLUMN example"),
      env.DB_NA.prepare("ALTER TABLE files DROP COLUMN sent_back_at"),
      env.DB_NA.prepare("DROP TABLE examples"),
    ]);
    const cols = "id, position, label, help, required, status, reject_note, reviewed_at";
    const before = {
      items: (await env.DB_NA.prepare(`SELECT ${cols} FROM items ORDER BY position`).all()).results,
      files: (await env.DB_NA.prepare("SELECT id, item_id, name, size FROM files").all()).results,
    };
    const migration = (env.TEST_MIGRATIONS_NA as { name: string; queries: string[] }[]).find((m) => m.name.startsWith("0020"))!;
    await env.DB_NA.batch(migration.queries.map((q) => env.DB_NA.prepare(q)));

    expect((await env.DB_NA.prepare(`SELECT ${cols} FROM items ORDER BY position`).all()).results).toEqual(before.items);
    expect((await env.DB_NA.prepare("SELECT id, item_id, name, size FROM files").all()).results).toEqual(before.files);
    expect(await env.DB_NA.prepare("SELECT reject_reasons, example FROM items WHERE id = ?").bind(item).first()).toEqual({ reject_reasons: null, example: null });
    expect((await env.DB_NA.prepare("SELECT sent_back_at FROM files WHERE id = ?").bind(file.id).first<any>())!.sent_back_at).toBeNull();
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM examples").first<any>())!.n).toBe(0);
    expect((await env.DB_NA.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_items_example'").all()).results).toHaveLength(1);
    expect((await env.DB_NA.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

    // an item sent back before the migration reads as having no reasons, only its note
    const view = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    expect(view.items[0]).toMatchObject({ status: "rejected", reject_note: "Old note", reject_reasons: [], example: null });
  });
});
