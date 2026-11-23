import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeExpired } from "../src/purge";
import { runReminders } from "../src/reminders";
import { HOUR, MINUTE, RESTORE_WINDOW } from "../src/util";
import { api, mockOutbound, openRequest, pdf, setup, upload } from "./helpers";

const ADDRESS = "12 King St W\nToronto ON M5H 1A1";

const ask = (path: string, body: unknown) => api(`${path}/notes`, { method: "POST", body });
const answer = (cookie: string, req: string, body: unknown) => api(`/api/requests/${req}/notes`, { method: "POST", cookie, body });
const thread = async (cookie: string, req: string) => (await api(`/api/requests/${req}/notes`, { cookie })).json<any>();
const count = async (table: string) => (await env.DB_NA.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<any>())!.n as number;

async function ready() {
  const o = await openRequest();
  await api("/api/firm", { method: "PATCH", cookie: o.cookie, body: { address: ADDRESS, phone: "416-555-0100" } });
  await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
  return o;
}

describe("client questions", () => {
  it("adds to the thread and shows on the client page with who wrote it", async () => {
    const { path } = await openRequest();
    const res = await ask(path, { body: "  Can I send a photo of my passport?  " });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ author: "client", body: "Can I send a photo of my passport?" });
    const page = await (await api(path)).json<any>();
    expect(page.notes).toMatchObject([{ author: "client", body: "Can I send a photo of my passport?" }]);
    expect(page.notes[0].created_at).toBeGreaterThan(0);
    expect(Object.keys(page.notes[0]).sort()).toEqual(["author", "body", "created_at", "id"]);
    const logged = (await env.DB_NA.prepare("SELECT actor_type, action, object_type FROM audit WHERE action = 'note.post'").all<any>()).results;
    expect(logged).toEqual([{ actor_type: "client", action: "note.post", object_type: "note" }]);
  });

  it("takes plain text of 1 to 2000 characters", async () => {
    const { path } = await openRequest();
    for (const body of [undefined, "", "x".repeat(2001), 5]) expect([body, (await ask(path, { body })).status]).toEqual([body, 400]);
    expect((await ask(path, { body: "x".repeat(2000) })).status).toBe(201);
    expect((await ask(path, "nope")).status).toBe(400);
    expect(await count("notes")).toBe(1);
  });

  it("is refused for a closed request and a wrong link", async () => {
    const { cookie, req, path } = await openRequest();
    expect((await ask(path.replace(/\/c\/.*/, "/c/na_" + "a".repeat(43)), { body: "hi" })).status).toBe(404);
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    expect((await ask(path, { body: "hi" })).status).toBe(404);
    expect(await count("notes")).toBe(0);
  });

  it("is rate limited per link", async () => {
    const { path } = await openRequest();
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await ask(path, { body: `q${i}` })).status);
    expect(codes.slice(0, 6)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(codes.slice(6)).toEqual([429, 429, 429, 429]);
    expect(await count("notes")).toBe(6);
  });

  it("keeps a daily and a total cap per request", async () => {
    const { req, path } = await openRequest();
    const row = (await env.DB_NA.prepare("SELECT firm_id FROM requests").first<any>())!;
    const fill = (n: number, at: number) =>
      env.DB_NA.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})
         INSERT INTO notes (id, firm_id, request_id, author, body, created_at) SELECT lower(hex(randomblob(16))), ?, ?, 'client', 'x', ? FROM n`,
      )
        .bind(row.firm_id, req.id, at)
        .run();
    await fill(20, Date.now() - HOUR);
    const res = await ask(path, { body: "one more" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too_many_notes" });
    await env.DB_NA.prepare("UPDATE notes SET created_at = 1").run();
    expect((await ask(path, { body: "today" })).status).toBe(201);
    await fill(200, 1);
    expect((await ask(path, { body: "too many in all" })).status).toBe(429);
  });

  it("tells the account in the owner notice, batched with uploads", async () => {
    const o = await ready();
    await ask(o.path, { body: "Question one" });
    await ask(o.path, { body: "Question two" });
    await upload(o.path, o.req.items[0].id, pdf(500));
    const sent = mockOutbound();
    await runReminders(env, Date.now());
    const notices = sent.filter((m) => m.to[0] === "owner@firm.test");
    expect(notices).toHaveLength(1);
    expect(notices[0].subject).toBe("Amy uploaded 1 document, sent 2 messages on 2025 taxes");
    expect(notices[0].text).not.toContain("Question one");
    expect(notices[0].text).toContain(`https://collect.alazy.app/requests/${o.req.id}`);

    await new Promise((done) => setTimeout(done, 5));
    await ask(o.path, { body: "Question three" });
    await runReminders(env, Date.now() + 30 * MINUTE);
    expect(sent.filter((m) => m.to[0] === "owner@firm.test")).toHaveLength(1);
    await runReminders(env, Date.now() + 2 * HOUR);
    expect(sent.filter((m) => m.to[0] === "owner@firm.test").map((m) => m.subject)[1]).toBe("Amy sent 1 message on 2025 taxes");
  });

  it("lists a request with an unanswered question under To review until it is answered", async () => {
    const o = await ready();
    const view = async () => (await (await api("/api/requests?view=to_review", { cookie: o.cookie })).json<any>()).rows.map((r: any) => r.id);
    expect(await view()).toEqual([]);
    await ask(o.path, { body: "Question" });
    expect(await view()).toEqual([o.req.id]);
    mockOutbound();
    await answer(o.cookie, o.req.id, { body: "Answer" });
    expect(await view()).toEqual([]);
  });
});

describe("the account's side of the thread", () => {
  it("counts unanswered client notes and clears them with an answer", async () => {
    const o = await ready();
    expect(await thread(o.cookie, o.req.id)).toEqual({ notes: [], unanswered: 0 });
    await ask(o.path, { body: "First" });
    await ask(o.path, { body: "Second" });
    const before = await thread(o.cookie, o.req.id);
    expect(before.unanswered).toBe(2);
    expect(before.notes.map((n: any) => [n.author, n.body])).toEqual([["client", "First"], ["client", "Second"]]);

    mockOutbound();
    const res = await answer(o.cookie, o.req.id, { body: "Here is the answer" });
    expect(res.status).toBe(201);
    const after = await thread(o.cookie, o.req.id);
    expect(after.unanswered).toBe(0);
    expect(after.notes.map((n: any) => n.author)).toEqual(["client", "client", "user"]);
    await ask(o.path, { body: "Thanks, one more" });
    expect((await thread(o.cookie, o.req.id)).unanswered).toBe(1);
    expect((await env.DB_NA.prepare("SELECT user_id FROM notes WHERE author = 'user'").first<any>())!.user_id).toBeTruthy();
    expect((await env.DB_NA.prepare("SELECT action FROM audit WHERE action = 'note.answer'").all()).results).toHaveLength(1);
  });

  it("shows the answer on the client page and emails the client a pointer to it", async () => {
    const o = await ready();
    await ask(o.path, { body: "Question" });
    const sent = mockOutbound();
    const res = await answer(o.cookie, o.req.id, { body: "Private answer text" });
    expect(await res.json()).toMatchObject({ emailed: true, email: "sent", note: { author: "user", body: "Private answer text" } });
    const page = await (await api(o.path)).json<any>();
    expect(page.notes.map((n: any) => n.author)).toEqual(["client", "user"]);

    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail.to).toEqual(["amy@mail.test"]);
    expect(mail.reply_to).toBe("owner@firm.test");
    expect(mail.subject).toBe("Tuna Tax replied: 2025 taxes");
    for (const part of [mail.text, mail.html]) {
      expect(part).not.toContain("Private answer text");
      expect(part).toContain("12 King St W");
      expect(part).toContain("/u/na_");
      expect(part).toContain(`/c/${o.path.split("/c/")[1]}`);
    }
    expect(mail.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(await env.DB_NA.prepare("SELECT kind, status, seq FROM messages WHERE kind = 'answer'").all()).toMatchObject({ results: [{ kind: "answer", status: "sent", seq: 1 }] });
  });

  it("sends one email for a run of answers within half an hour", async () => {
    const o = await ready();
    const sent = mockOutbound();
    expect(await (await answer(o.cookie, o.req.id, { body: "One" })).json()).toMatchObject({ email: "sent" });
    expect(await (await answer(o.cookie, o.req.id, { body: "Two" })).json()).toMatchObject({ emailed: false, email: "recent" });
    expect(sent).toHaveLength(1);
    expect(await count("notes")).toBe(2);
    await env.DB_NA.prepare("UPDATE messages SET sent_at = sent_at - ?").bind(31 * MINUTE).run();
    expect(await (await answer(o.cookie, o.req.id, { body: "Three" })).json()).toMatchObject({ email: "sent" });
    expect(sent).toHaveLength(2);
  });

  it("saves the answer but sends no email to a client who unsubscribed or has no address", async () => {
    const o = await ready();
    const sent = mockOutbound();
    await env.DB_NA.prepare("UPDATE clients SET email_stop_at = 1").run();
    expect(await (await answer(o.cookie, o.req.id, { body: "One" })).json()).toMatchObject({ emailed: false, email: "unsubscribed" });
    await env.DB_NA.prepare("UPDATE clients SET email_stop_at = NULL, email = NULL").run();
    expect(await (await answer(o.cookie, o.req.id, { body: "Two" })).json()).toMatchObject({ emailed: false, email: "no_email" });
    await env.DB_NA.prepare("UPDATE clients SET email = 'amy@mail.test', email_ok_at = NULL").run();
    expect(await (await answer(o.cookie, o.req.id, { body: "Three" })).json()).toMatchObject({ emailed: false, email: "no_email" });
    expect(sent).toHaveLength(0);
    expect(await count("notes")).toBe(3);
  });

  it("sends no email while the account has no mailing address or plan, but saves the answer", async () => {
    const o = await openRequest();
    const sent = mockOutbound();
    expect(await (await answer(o.cookie, o.req.id, { body: "One" })).json()).toMatchObject({ emailed: false, email: "not_set_up" });
    expect(sent).toHaveLength(0);
    expect(await count("notes")).toBe(1);
  });

  it("stops at the account's daily email cap", async () => {
    const o = await ready();
    const row = (await env.DB_NA.prepare("SELECT firm_id, client_id FROM requests").first<any>())!;
    await env.DB_NA
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
         INSERT INTO messages (id, firm_id, request_id, client_id, channel, kind, seq, template_version, body_hash, status, attempts, sent_at)
         SELECT lower(hex(randomblob(16))), ?, ?, ?, 'email', 'rejected', 100 + i, 1, 'x', 'sent', 1, ? FROM n`,
      )
      .bind(row.firm_id, o.req.id, row.client_id, Date.now() - HOUR)
      .run();
    const sent = mockOutbound();
    expect(await (await answer(o.cookie, o.req.id, { body: "One" })).json()).toMatchObject({ emailed: false, email: "email_limit" });
    expect(sent).toHaveLength(0);
  });

  it("takes 1 to 2000 characters and refuses a closed request", async () => {
    const o = await ready();
    mockOutbound();
    for (const body of [undefined, "", " ", "x".repeat(2001), 3]) expect([body, (await answer(o.cookie, o.req.id, { body })).status]).toEqual([body, 400]);
    expect((await answer(o.cookie, o.req.id, { body: "x".repeat(2000) })).status).toBe(201);
    await api(`/api/requests/${o.req.id}/close`, { method: "POST", cookie: o.cookie });
    expect((await answer(o.cookie, o.req.id, { body: "late" })).status).toBe(409);
    expect((await answer(o.cookie, "0".repeat(32), { body: "x" })).status).toBe(404);
  });

  it("needs a session", async () => {
    const o = await ready();
    expect((await api(`/api/requests/${o.req.id}/notes`)).status).toBe(401);
    expect((await answer("", o.req.id, { body: "x" })).status).toBe(401);
  });
});

describe("isolation, purge and export", () => {
  it("keeps one account's thread from another's", async () => {
    const a = await openRequest("a@firm.test");
    await ask(a.path, { body: "Only for A" });
    const b = await setup("b@firm.test", "Other Tax");
    expect((await api(`/api/requests/${a.req.id}/notes`, { cookie: b.cookie })).status).toBe(404);
    expect((await answer(b.cookie, a.req.id, { body: "Intruder" })).status).toBe(404);
    expect(await count("notes")).toBe(1);

    const other = await (await api("/api/requests", { method: "POST", cookie: b.cookie, body: { client_id: b.client.id, title: "B taxes", deadline: Date.now() + 5 * 86_400_000, items: [{ label: "x" }] } })).json<any>();
    const { url } = await (await api(`/api/requests/${other.id}/link`, { method: "POST", cookie: b.cookie })).json<any>();
    const page = await (await api(`/api/c/${url.split("/c/")[1]}`)).json<any>();
    expect(page.notes).toEqual([]);
  });

  it("removes the thread with the request and keeps no text in the audit rows or the log", async () => {
    const o = await ready();
    await ask(o.path, { body: "Secret question" });
    mockOutbound();
    await answer(o.cookie, o.req.id, { body: "Secret answer" });
    await api(`/api/requests/${o.req.id}`, { method: "DELETE", cookie: o.cookie });
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1").run();
    await purgeExpired(env, Date.now() + RESTORE_WINDOW);
    expect(await count("notes")).toBe(0);
    expect(await count("requests")).toBe(0);
    const text = JSON.stringify([(await env.DB_NA.prepare("SELECT * FROM audit").all()).results, (await env.DB_NA.prepare("SELECT * FROM message_log").all()).results]);
    expect(text).not.toContain("Secret");
  });

  it("adds the thread to the zip as messages.txt", async () => {
    const o = await ready();
    await upload(o.path, o.req.items[0].id, pdf(500), { name: "a.pdf" });
    await ask(o.path, { body: "Is this the right page?" });
    mockOutbound();
    await answer(o.cookie, o.req.id, { body: "Yes, thank you" });
    const res = await api(`/api/requests/${o.req.id}/export`, { cookie: o.cookie });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw).toContain("messages.txt");
    expect(raw).toMatch(/UTC, client\nIs this the right page\?\n\n\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, account\nYes, thank you\n/);
  });

  it("leaves messages.txt out when there is no thread", async () => {
    const o = await ready();
    await upload(o.path, o.req.items[0].id, pdf(500), { name: "a.pdf" });
    const res = await api(`/api/requests/${o.req.id}/export`, { cookie: o.cookie });
    expect(new TextDecoder("latin1").decode(new Uint8Array(await res.arrayBuffer()))).not.toContain("messages.txt");
  });
});

describe("thread limits and reply emails", () => {
  it("emails a reply again when the client wrote after the last one", async () => {
    const o = await ready();
    const sent = mockOutbound();
    await answer(o.cookie, o.req.id, { body: "One" });
    await new Promise((done) => setTimeout(done, 5));
    await ask(o.path, { body: "Another question" });
    expect(await (await answer(o.cookie, o.req.id, { body: "Two" })).json()).toMatchObject({ email: "sent" });
    expect(sent).toHaveLength(2);
  });

  it("shows the newest 300 notes, oldest first, on both sides", async () => {
    const o = await ready();
    const row = (await env.DB_NA.prepare("SELECT firm_id FROM requests").first<any>())!;
    await env.DB_NA
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 310)
         INSERT INTO notes (id, firm_id, request_id, author, body, created_at) SELECT lower(hex(randomblob(16))), ?, ?, 'user', 'n' || i, 1000 + i FROM n`,
      )
      .bind(row.firm_id, o.req.id)
      .run();
    const mine = (await thread(o.cookie, o.req.id)).notes.map((n: any) => n.body);
    expect([mine.length, mine[0], mine[299]]).toEqual([300, "n11", "n310"]);
    const page = (await (await api(o.path)).json<any>()).notes.map((n: any) => n.body);
    expect([page.length, page[0], page[299]]).toEqual([300, "n11", "n310"]);
  });

  it("caps the account's notes per request", async () => {
    const o = await ready();
    mockOutbound();
    const row = (await env.DB_NA.prepare("SELECT firm_id FROM requests").first<any>())!;
    await env.DB_NA
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
         INSERT INTO notes (id, firm_id, request_id, author, body, created_at) SELECT lower(hex(randomblob(16))), ?, ?, 'user', 'x', 1 FROM n`,
      )
      .bind(row.firm_id, o.req.id)
      .run();
    const res = await answer(o.cookie, o.req.id, { body: "one more" });
    expect([res.status, (await res.json<any>()).error]).toEqual([429, "too_many_notes"]);
  });
});

describe("contact on the client page", () => {
  it("is what an email would show, and absent when the account cannot send", async () => {
    const o = await openRequest();
    expect((await (await api(o.path)).json<any>()).contact).toBeNull();
    await api("/api/firm", { method: "PATCH", cookie: o.cookie, body: { address: ADDRESS, phone: "416-555-0100" } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    expect((await (await api(o.path)).json<any>()).contact).toMatchObject({ email: "owner@firm.test", phone: "416-555-0100", address: ADDRESS });
  });
});
