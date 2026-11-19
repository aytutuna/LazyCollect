import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runReminders } from "../src/reminders";
import { addDays, atHour, dayOf, nextOpening, nextReminder } from "../src/tz";
import { unsubUrl } from "../src/mail";
import { DAY, HOUR, MINUTE, sha256 } from "../src/util";
import { api, mockOutbound, openRequest, pdf, review, setup, upload, type Sent } from "./helpers";

const TZ = "America/Toronto";
const at = (y: number, m: number, d: number, h: number, min = 0) => atHour({ y, m, d }, h, TZ) + min * MINUTE;
const DEADLINE = at(2027, 1, 20, 23, 59);
const ADDRESS = "12 King St W\nToronto ON M5H 1A1";

async function ready() {
  const { cookie, client } = await setup();
  await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS, phone: "416-555-0100" } });
  await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
  const req = await (
    await api("/api/requests", {
      method: "POST",
      cookie,
      body: {
        client_id: client.id,
        title: "2025 taxes",
        deadline: Date.now() + 400 * DAY,
        items: [{ label: "Passport", required: true }, { label: "T4 slip", required: true }, { label: "Donation receipts", required: false }],
      },
    })
  ).json<any>();
  return { cookie, client, req };
}

// the clock is passed to the cron, so a request is moved to fixed dates instead
async function pin(reqId: string, next: number | null, seq = 0) {
  await env.DB_NA.batch([
    env.DB_NA.prepare("UPDATE requests SET deadline = ?, next_reminder_at = ?, reminder_seq = ? WHERE id = ?").bind(DEADLINE, next, seq, reqId),
    env.DB_NA.prepare("UPDATE links SET expires_at = ? WHERE request_id = ?").bind(DEADLINE + 30 * DAY, reqId),
  ]);
}

const invite = (cookie: string, reqId: string, body: object = { send_email: true }) =>
  api(`/api/requests/${reqId}/link`, { method: "POST", cookie, body });

async function messages() {
  return (await env.DB_NA.prepare("SELECT * FROM messages ORDER BY sent_at, rowid").all<any>()).results;
}

const requestRow = (id: string) => env.DB_NA.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first<any>();

describe("zones", () => {
  it("finds 9:00 across daylight saving changes", () => {
    expect(new Date(at(2027, 3, 14, 9)).toISOString()).toBe("2027-03-14T13:00:00.000Z");
    expect(new Date(at(2027, 3, 13, 9)).toISOString()).toBe("2027-03-13T14:00:00.000Z");
    expect(new Date(at(2027, 11, 7, 9)).toISOString()).toBe("2027-11-07T14:00:00.000Z");
  });

  it("opens at the next 9:00", () => {
    expect(nextOpening(at(2027, 1, 5, 7), TZ)).toBe(at(2027, 1, 5, 9));
    expect(nextOpening(at(2027, 1, 5, 12), TZ)).toBe(at(2027, 1, 6, 9));
    expect(nextOpening(at(2027, 1, 5, 21), TZ)).toBe(at(2027, 1, 6, 9));
  });
});

describe("cadence", () => {
  it("waits three days after the link far from the deadline", () => {
    const sent = at(2026, 12, 1, 14, 23);
    expect(nextReminder(sent, DEADLINE, TZ, true)).toBe(sent + 3 * DAY);
  });

  it("goes weekly, then two days before the deadline and on its morning, and ends with the note", () => {
    const steps: number[] = [];
    let t = at(2027, 1, 5, 10, 5);
    for (let i = 0; i < 4; i++) {
      t = nextReminder(t, DEADLINE, TZ, false);
      steps.push(t);
    }
    expect(steps).toEqual([at(2027, 1, 12, 10, 5), at(2027, 1, 18, 9), at(2027, 1, 20, 9), at(2027, 1, 21, 9)]);
  });

  it("drops a fixed reminder that would follow another within 36 hours", () => {
    expect(nextReminder(at(2027, 1, 17, 10), DEADLINE, TZ, false)).toBe(at(2027, 1, 20, 9));
    expect(nextReminder(at(2027, 1, 19, 10), DEADLINE, TZ, false)).toBe(at(2027, 1, 21, 9));
  });

  it("never picks the same day twice", () => {
    const after = at(2027, 1, 18, 9, 30);
    const next = nextReminder(after, DEADLINE, TZ, false);
    expect(dayOf(next, TZ)).not.toEqual(dayOf(after, TZ));
  });

  // every email a client gets for one request: the reminders and the closing note
  function schedule(days: number) {
    const due = at(2027, 3, 1 + days, 23, 59);
    const link = at(2027, 3, 1, 10);
    const sends: number[] = [];
    let t = nextReminder(link, due, TZ, true);
    for (;;) {
      sends.push(t);
      if (t > due) return sends;
      t = nextReminder(t, due, TZ, false);
    }
  }

  it("sends 5 emails for a 14 day request and 7 for a 30 day one", () => {
    expect(schedule(14)).toHaveLength(5);
    expect(schedule(30)).toHaveLength(7);
    for (const days of [14, 30]) {
      const gaps = schedule(days).slice(1).map((t, i) => t - schedule(days)[i]);
      // 36 hours apart, except the closing note which follows the deadline morning
      expect(gaps.slice(0, -1).every((g) => g >= 36 * HOUR)).toBe(true);
    }
  });
});

describe("invite email", () => {
  it("sends once with the sender details, reply-to and no promotion", async () => {
    const { cookie, client, req } = await ready();
    await api("/api/firm", { method: "PATCH", cookie, body: { legal_name: "Tuna Tax Services Inc." } });
    const sent = mockOutbound();
    const res = await invite(cookie, req.id);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.emailed).toBe(true);
    expect(sent).toHaveLength(1);

    const mail = sent[0];
    expect(mail.to).toEqual(["amy@mail.test"]);
    expect(mail.reply_to).toBe("owner@firm.test");
    expect(mail.from).toBe('"Tuna Tax Services Inc. via Lazy Collect" <noreply@alazy.app>');
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain("Tuna Tax Services Inc.");
      expect(part).toContain("12 King St W");
      expect(part).toContain("owner@firm.test");
      expect(part).toContain("416-555-0100");
      expect(part).toContain(body.url);
      expect(part).toContain("/u/na_");
      expect(part).toContain("Passport");
      expect(part).toContain("T4 slip");
      expect(part).toContain("Donation receipts");
      expect(part).not.toMatch(/lazy collect/i);
    }
    expect(mail.subject).not.toMatch(/lazy collect/i);
    expect(mail.headers!["List-Unsubscribe"]).toMatch(/^<https:\/\/collect\.alazy\.app\/u\/na_[0-9a-f]+>$/);
    expect(mail.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "invite", seq: 1, channel: "email", status: "sent", template_version: 1, provider_id: "email_1", client_id: client.id });
    expect(rows[0].body_hash).toBe(await sha256(`${mail.subject}\n${mail.text}\n${mail.html}`));
  });

  it("sanitises the sender name in the From header", async () => {
    const { cookie, req } = await ready();
    await api("/api/firm", { method: "PATCH", cookie, body: { legal_name: 'Evil "Co" <x@y.test>\nBcc: z@y.test' } });
    const sent = mockOutbound();
    await invite(cookie, req.id);
    expect(sent[0].from).toMatch(/^"[^"<>\r\n]+ via Lazy Collect" <noreply@alazy\.app>$/);
  });

  it("does not send without send_email", async () => {
    const { cookie, req } = await ready();
    const sent = mockOutbound();
    const body = await (await invite(cookie, req.id, {})).json<any>();
    expect(body.url).toContain("/c/na_");
    expect(body.emailed).toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(await messages()).toHaveLength(0);
  });

  it("asks for a mailing address first", async () => {
    const { cookie, client } = await setup();
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "A", deadline: Date.now() + 5 * DAY } })).json<any>();
    const sent = mockOutbound();
    const res = await invite(cookie, req.id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "address_needed" });
    expect(sent).toHaveLength(0);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM links").first<any>()).n).toBe(0);
  });

  it("needs a client email with consent", async () => {
    const { cookie } = await ready();
    const other = await (await api("/api/clients", { method: "POST", cookie, body: { name: "Bo", email: "bo@mail.test", contact_ok: false } })).json<any>();
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: other.id, title: "B", deadline: Date.now() + 5 * DAY } })).json<any>();
    const sent = mockOutbound();
    const res = await invite(cookie, req.id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "client_email_needed" });
    expect(sent).toHaveLength(0);
  });

  it("still returns the link when the email fails", async () => {
    const { cookie, req } = await ready();
    mockOutbound(true, false);
    const res = await invite(cookie, req.id);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.email_failed).toBe(true);
    expect(body.url).toContain("/c/na_");
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM links WHERE revoked_at IS NULL").first<any>()).n).toBe(1);
    expect((await messages())[0]).toMatchObject({ kind: "invite", status: "failed" });
  });
});

describe("reminders", () => {
  it("schedules the first reminder three days after the invite", async () => {
    const { cookie, req } = await ready();
    mockOutbound();
    await invite(cookie, req.id);
    const row = await requestRow(req.id);
    expect(row.next_reminder_at - row.sent_at).toBe(3 * DAY);
  });

  it("sends a reminder with only what is missing, required first, and the same link", async () => {
    const { cookie, req } = await ready();
    const sent = mockOutbound();
    const { url } = await (await invite(cookie, req.id)).json<any>();
    await pin(req.id, at(2027, 1, 5, 10));
    const [passport, t4] = req.items.map((i: any) => i.id);
    await env.DB_NA.batch([
      env.DB_NA.prepare("UPDATE items SET status = 'rejected', reject_note = 'Page 2 is cut off' WHERE id = ?").bind(passport),
      env.DB_NA.prepare("UPDATE items SET status = 'approved' WHERE id = ?").bind(t4),
    ]);
    sent.length = 0;
    await runReminders(env, at(2027, 1, 5, 10, 5));
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail.subject).toBe("Reminder: 2025 taxes, due January 20, 2027");
    expect(mail.text).toContain("Passport (sent back: Page 2 is cut off)");
    expect(mail.text).toContain("Donation receipts");
    expect(mail.text).not.toContain("T4 slip");
    expect(mail.text.indexOf("Still needed:")).toBeLessThan(mail.text.indexOf("If they apply to you:"));
    expect(mail.text).toContain(url);
    expect(mail.text).toContain("12 King St W");
    expect(mail.text).toContain("/u/na_");
    expect(mail.reply_to).toBe("owner@firm.test");
    expect(mail.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    const row = await requestRow(req.id);
    expect(row.reminder_seq).toBe(1);
    expect(row.next_reminder_at).toBe(at(2027, 1, 12, 10, 5));
    const logged = (await messages()).filter((m) => m.kind === "reminder");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ seq: 1, status: "sent" });
    expect(logged[0].body_hash).toBe(await sha256(`${mail.subject}\n${mail.text}\n${mail.html}`));
  });

  it("sends nothing on a second run in the same window", async () => {
    const { cookie, req } = await ready();
    const sent = mockOutbound();
    await invite(cookie, req.id);
    await pin(req.id, at(2027, 1, 5, 10));
    sent.length = 0;
    await runReminders(env, at(2027, 1, 5, 10, 5));
    await runReminders(env, at(2027, 1, 5, 10, 15));
    expect(sent).toHaveLength(1);
  });

  it("cannot double-send when two runs overlap", async () => {
    const { cookie, req } = await ready();
    const sent = mockOutbound();
    await invite(cookie, req.id);
    await pin(req.id, at(2027, 1, 5, 10));
    sent.length = 0;
    const now = at(2027, 1, 5, 10, 5);
    await Promise.all([runReminders(env, now), runReminders(env, now)]);
    expect(sent).toHaveLength(1);
    expect((await messages()).filter((m) => m.kind === "reminder")).toHaveLength(1);
  });

  it("settles a slot that was sent before the run crashed", async () => {
    const { cookie, req } = await ready();
    const sent = mockOutbound();
    await invite(cookie, req.id);
    await pin(req.id, at(2027, 1, 5, 10));
    sent.length = 0;
    await runReminders(env, at(2027, 1, 5, 10, 5));
    await pin(req.id, at(2027, 1, 5, 10), 0);
    await runReminders(env, at(2027, 1, 5, 10, 15));
    await runReminders(env, at(2027, 1, 7, 9, 5));
    expect(sent).toHaveLength(1);
    expect((await requestRow(req.id)).reminder_seq).toBe(1);
  });

  it("waits out quiet hours", async () => {
    const { cookie, req } = await ready();
    const sent = mockOutbound();
    await invite(cookie, req.id);
    await pin(req.id, at(2027, 1, 5, 6));
    sent.length = 0;
    await runReminders(env, at(2027, 1, 5, 7));
    expect(sent).toHaveLength(0);
    expect((await requestRow(req.id)).next_reminder_at).toBe(at(2027, 1, 5, 9));

    await pin(req.id, at(2027, 1, 5, 19));
    await runReminders(env, at(2027, 1, 5, 19, 10));
    expect(sent).toHaveLength(0);
    expect((await requestRow(req.id)).next_reminder_at).toBe(at(2027, 1, 6, 9));

    await runReminders(env, at(2027, 1, 6, 9, 2));
    expect(sent).toHaveLength(1);
  });

  it("sends a client at most one reminder in 36 hours across requests", async () => {
    const { cookie, client, req } = await ready();
    const second = await (
      await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "Second", deadline: Date.now() + 400 * DAY, items: [{ label: "ID", required: true }] } })
    ).json<any>();
    const sent = mockOutbound();
    await invite(cookie, req.id);
    await invite(cookie, second.id);
    await pin(req.id, at(2027, 1, 5, 10));
    await pin(second.id, at(2027, 1, 5, 10, 1));
    sent.length = 0;
    await runReminders(env, at(2027, 1, 5, 11));
    expect(sent).toHaveLength(1);
    expect((await requestRow(second.id)).next_reminder_at).toBe(at(2027, 1, 7, 9));
    await runReminders(env, at(2027, 1, 6, 9, 5));
    expect(sent).toHaveLength(1);
    await runReminders(env, at(2027, 1, 7, 9, 5));
    expect(sent).toHaveLength(2);
  });

  const stops: [string, (o: { cookie: string; client: any; req: any }) => Promise<unknown>][] = [
    ["complete", () => env.DB_NA.prepare("UPDATE requests SET status = 'complete'").run()],
    ["closed", ({ cookie, req }) => api(`/api/requests/${req.id}/close`, { method: "POST", cookie })],
    ["deleted", ({ cookie, req }) => api(`/api/requests/${req.id}`, { method: "DELETE", cookie })],
    ["reminders off", ({ cookie, req }) => api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { reminders_on: false } })],
    ["unsubscribed", () => env.DB_NA.prepare("UPDATE clients SET email_stop_at = 1").run()],
    ["no email", ({ cookie, client }) => api(`/api/clients/${client.id}`, { method: "PATCH", cookie, body: { email: "" } })],
    ["no consent", ({ cookie, client }) => api(`/api/clients/${client.id}`, { method: "PATCH", cookie, body: { contact_ok: false } })],
  ];

  it.each(stops)("stops when %s", async (_name, stop) => {
    const o = await ready();
    const sent = mockOutbound();
    await invite(o.cookie, o.req.id);
    await stop(o);
    await pin(o.req.id, at(2027, 1, 5, 10));
    sent.length = 0;
    await runReminders(env, at(2027, 1, 5, 10, 5));
    expect(sent).toHaveLength(0);
  });

  it("does not remind an account without a mailing address", async () => {
    const { cookie, req } = await ready();
    const sent = mockOutbound();
    await invite(cookie, req.id);
    await env.CONTROL.prepare("UPDATE firms SET address = NULL").run();
    await pin(req.id, at(2027, 1, 5, 10));
    sent.length = 0;
    await runReminders(env, at(2027, 1, 5, 10, 5));
    expect(sent).toHaveLength(0);
    expect((await requestRow(req.id)).next_reminder_at).toBe(at(2027, 1, 5, 10, 5) + DAY);
  });

  it("sends one deadline note the day after and stops", async () => {
    const { cookie, req } = await ready();
    const sent = mockOutbound();
    await invite(cookie, req.id);
    await pin(req.id, at(2027, 1, 21, 9), 6);
    sent.length = 0;
    await runReminders(env, at(2027, 1, 21, 9, 3));
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Deadline passed: 2025 taxes");
    expect(sent[0].text).toContain("/u/na_");
    const row = await requestRow(req.id);
    expect(row.status).toBe("open");
    expect(row.next_reminder_at).toBeNull();
    await runReminders(env, at(2027, 1, 22, 9, 3));
    await runReminders(env, at(2027, 1, 30, 9, 3));
    expect(sent).toHaveLength(1);
    expect((await messages()).filter((m) => m.kind === "deadline")).toHaveLength(1);
  });

  it("retries a failed send twice and then moves on", async () => {
    const { cookie, req } = await ready();
    mockOutbound();
    await invite(cookie, req.id);
    await pin(req.id, at(2027, 1, 5, 10));
    mockOutbound(true, 422);
    for (const min of [5, 15, 25]) await runReminders(env, at(2027, 1, 5, 10, min));
    let row = (await messages()).find((m) => m.kind === "reminder");
    expect(row).toMatchObject({ status: "failed", attempts: 3 });
    expect((await requestRow(req.id)).reminder_seq).toBe(0);
    await runReminders(env, at(2027, 1, 5, 10, 35));
    row = (await messages()).filter((m) => m.kind === "reminder")[0];
    expect(row.attempts).toBe(3);
    expect((await requestRow(req.id)).reminder_seq).toBe(1);
  });

  it("gives up on a last attempt that never reported back", async () => {
    const { cookie, req } = await ready();
    const sent = mockOutbound();
    await invite(cookie, req.id);
    await pin(req.id, at(2027, 1, 5, 10));
    await env.DB_NA.prepare(
      "INSERT INTO messages (id, firm_id, request_id, client_id, channel, kind, seq, template_version, body_hash, status, attempts, sent_at) SELECT lower(hex(randomblob(16))), firm_id, id, client_id, 'email', 'reminder', 1, 1, 'x', 'sending', 3, ? FROM requests",
    ).bind(at(2027, 1, 1, 8)).run();
    sent.length = 0;
    await runReminders(env, at(2027, 1, 5, 10, 5));
    expect(sent).toHaveLength(0);
    expect((await requestRow(req.id)).reminder_seq).toBe(1);
  });

  it("does not count a busy provider against the attempts and pauses the pass", async () => {
    const { cookie, client, req } = await ready();
    const second = await (
      await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "Second", deadline: Date.now() + 400 * DAY, items: [{ label: "ID", required: true }] } })
    ).json<any>();
    mockOutbound();
    await invite(cookie, req.id);
    await invite(cookie, second.id);
    await pin(req.id, at(2027, 1, 5, 10));
    await pin(second.id, at(2027, 1, 5, 10, 1));
    for (const status of [429, 503]) {
      mockOutbound(true, status);
      for (const min of [5, 15, 25, 35]) await runReminders(env, at(2027, 1, 5, 10, min));
    }
    const rows = (await messages()).filter((m) => m.kind === "reminder");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", attempts: 0 });
    expect((await requestRow(req.id)).reminder_seq).toBe(0);
    const sent = mockOutbound();
    await runReminders(env, at(2027, 1, 5, 10, 45));
    expect(sent).toHaveLength(1);
  });

  it("leaves a pre-M4 link alone when the client has no email", async () => {
    const { cookie, client, req } = await ready();
    mockOutbound();
    await invite(cookie, req.id, {});
    await env.DB_NA.prepare("UPDATE links SET token_enc = NULL").run();
    await api(`/api/clients/${client.id}`, { method: "PATCH", cookie, body: { email: "" } });
    await pin(req.id, at(2027, 1, 5, 10));
    await runReminders(env, at(2027, 1, 5, 10, 5));
    const links = await env.DB_NA.prepare("SELECT revoked_at FROM links").all<any>();
    expect(links.results).toEqual([{ revoked_at: null }]);
  });

  it("recovers a failed send on the next run", async () => {
    const { cookie, req } = await ready();
    mockOutbound();
    await invite(cookie, req.id);
    await pin(req.id, at(2027, 1, 5, 10));
    mockOutbound(true, 422);
    await runReminders(env, at(2027, 1, 5, 10, 5));
    const sent = mockOutbound();
    await runReminders(env, at(2027, 1, 5, 10, 15));
    expect(sent).toHaveLength(1);
    const rows = (await messages()).filter((m) => m.kind === "reminder");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("toggles reminders and lists the messages", async () => {
    const { cookie, req } = await ready();
    mockOutbound();
    await invite(cookie, req.id);
    const off = await (await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { reminders_on: false } })).json<any>();
    expect(off).toMatchObject({ reminders_on: false, next_reminder_at: null });
    const on = await (await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { reminders_on: true } })).json<any>();
    expect(on.reminders_on).toBe(true);
    expect(on.next_reminder_at).toBeGreaterThan(Date.now());
    expect((await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { reminders_on: "yes" } })).status).toBe(400);
    const list = await (await api(`/api/requests/${req.id}/messages`, { cookie })).json<any[]>();
    expect(list.map((m) => [m.kind, m.status])).toEqual([["invite", "sent"]]);
  });
});

describe("rejected items email", () => {
  async function rejectBoth() {
    const o = await openRequest();
    await api("/api/firm", { method: "PATCH", cookie: o.cookie, body: { address: ADDRESS } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    for (const [i, note] of [[0, "Blurry"], [1, "Wrong year"]] as const) {
      const item = o.req.items[i].id;
      await upload(o.path, item, pdf(500));
      expect((await review(o.cookie, o.req.id, item, { decision: "reject", note })).status).toBe(200);
    }
    return o;
  }

  it("batches rejections into one email after a quiet spell", async () => {
    const o = await rejectBoth();
    const sent = mockOutbound();
    const mark = (await requestRow(o.req.id)).reject_mark_at;
    expect(mark).toBeGreaterThan(0);
    const day = addDays(dayOf(Date.now(), TZ), 1);
    await env.DB_NA.prepare("UPDATE requests SET reject_mark_at = ?").bind(atHour(day, 10, TZ)).run();
    await runReminders(env, atHour(day, 10, TZ) + 5 * MINUTE);
    expect(sent.filter((m) => m.subject.startsWith("Please resend"))).toHaveLength(0);
    await runReminders(env, atHour(day, 10, TZ) + 11 * MINUTE);
    const mails = sent.filter((m) => m.subject.startsWith("Please resend"));
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain("Passport (sent back: Blurry)");
    expect(mails[0].text).toContain("Visa (sent back: Wrong year)");
    expect(mails[0].text).toContain("/u/na_");
    await runReminders(env, atHour(day, 10, TZ) + 21 * MINUTE);
    expect(sent.filter((m) => m.subject.startsWith("Please resend"))).toHaveLength(1);
    expect((await messages()).filter((m) => m.kind === "rejected")).toMatchObject([{ seq: 1, status: "sent" }]);
    expect((await requestRow(o.req.id)).reject_mark_at).toBeNull();
  });

  it("sends nothing when the items were fixed in the meantime", async () => {
    const o = await rejectBoth();
    const sent = mockOutbound();
    await env.DB_NA.prepare("UPDATE items SET status = 'submitted'").run();
    const day = addDays(dayOf(Date.now(), TZ), 1);
    await env.DB_NA.prepare("UPDATE requests SET reject_mark_at = ?").bind(atHour(day, 10, TZ)).run();
    await runReminders(env, atHour(day, 11, TZ));
    expect(sent.filter((m) => m.subject.startsWith("Please resend"))).toHaveLength(0);
    expect((await requestRow(o.req.id)).reject_mark_at).toBeNull();
  });
});

describe("unsubscribe", () => {
  const token = (url: string) => new URL(url).pathname.slice(3);
  const post = (path: string, body?: string) =>
    exports.default.fetch(`https://collect.alazy.app${path}`, {
      method: "POST",
      headers: { "CF-Connecting-IP": "198.51.100.7", "content-type": "application/x-www-form-urlencoded" },
      body,
    });

  async function unsubscribeLink() {
    const o = await ready();
    const sent = mockOutbound();
    await invite(o.cookie, o.req.id);
    return { ...o, link: sent[0].text.match(/https:\/\/\S+\/u\/\S+/)![0] };
  }

  it("shows a page that changes nothing until the button is pressed", async () => {
    const { client, link } = await unsubscribeLink();
    const res = await api(`/u/${token(link)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<form");
    expect(html).toContain("Tuna Tax");
    expect(html).not.toContain("<script");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    const row = await env.DB_NA.prepare("SELECT email_stop_at FROM clients WHERE id = ?").bind(client.id).first<any>();
    expect(row.email_stop_at).toBeNull();
  });

  it("stops the client at once, once, and records it", async () => {
    const { client, req, cookie, link } = await unsubscribeLink();
    expect((await post(`/u/${token(link)}`)).status).toBe(200);
    const first = await env.DB_NA.prepare("SELECT email_stop_at FROM clients WHERE id = ?").bind(client.id).first<any>();
    expect(first.email_stop_at).toBeGreaterThan(0);
    expect((await post(`/u/${token(link)}`, "List-Unsubscribe=One-Click")).status).toBe(200);
    const again = await env.DB_NA.prepare("SELECT email_stop_at FROM clients WHERE id = ?").bind(client.id).first<any>();
    expect(again.email_stop_at).toBe(first.email_stop_at);
    const audits = await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'email.unsubscribe' AND object_id = ?").bind(client.id).first<any>();
    expect(audits.n).toBe(1);

    const sent = mockOutbound();
    expect((await invite(cookie, req.id)).status).toBe(400);
    await pin(req.id, at(2027, 1, 5, 10));
    await runReminders(env, at(2027, 1, 5, 10, 5));
    expect(sent).toHaveLength(0);
  });

  it("refuses forged tokens and tokens moved to another client", async () => {
    const { cookie, client, link } = await unsubscribeLink();
    const other = await (await api("/api/clients", { method: "POST", cookie, body: { name: "Bo", email: "bo@mail.test", contact_ok: true } })).json<any>();
    const real = token(link);
    const flipped = real.slice(0, -1) + (real.endsWith("0") ? "1" : "0");
    const moved = real.replace(client.id, other.id);
    for (const bad of [flipped, moved, "na_" + "0".repeat(96), "xx_abc", real.slice(0, 98)]) {
      expect((await api(`/u/${bad}`)).status).toBe(404);
      expect((await post(`/u/${bad}`)).status).toBe(404);
    }
    const rows = await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM clients WHERE email_stop_at IS NOT NULL").first<any>();
    expect(rows.n).toBe(0);
    const forThem = await unsubUrl(env, "na", other.id, (await env.CONTROL.prepare("SELECT id FROM firms").first<any>()).id);
    expect(forThem).not.toBe(link);
  });
});

describe("upload notice to the account", () => {
  const notices = (sent: Sent[]) => sent.filter((m) => m.to[0] === "owner@firm.test" && / uploaded \d+ /.test(m.subject));

  it("sends one plain note per hour with a count and a dashboard link", async () => {
    const o = await openRequest();
    const sent = mockOutbound();
    await upload(o.path, o.req.items[0].id, pdf(500));
    await upload(o.path, o.req.items[1].id, pdf(500));
    const now = Date.now();
    await runReminders(env, now);
    expect(notices(sent)).toHaveLength(1);
    const mail = notices(sent)[0];
    expect(mail.subject).toBe("Amy uploaded 2 documents to 2025 taxes");
    expect(mail.text).toContain(`https://collect.alazy.app/requests/${o.req.id}`);
    expect(mail.text).not.toMatch(/unsubscribe/i);

    await upload(o.path, o.req.items[0].id, pdf(600));
    await runReminders(env, now + 30 * MINUTE);
    expect(notices(sent)).toHaveLength(1);
    await runReminders(env, now + HOUR + MINUTE);
    expect(notices(sent)).toHaveLength(2);
    expect(notices(sent)[1].subject).toBe("Amy uploaded 1 document to 2025 taxes");
    await runReminders(env, now + 3 * HOUR);
    expect(notices(sent)).toHaveLength(2);
  });
});

describe("upload notice failures", () => {
  it("gives up after three failed tries", async () => {
    const o = await openRequest();
    await upload(o.path, o.req.items[0].id, pdf(500));
    mockOutbound(true, 422);
    const now = Date.now();
    for (const min of [0, 10, 20, 30]) await runReminders(env, now + min * MINUTE);
    const row = await requestRow(o.req.id);
    expect(row.notice_due_at).toBeNull();
    expect(row.notice_tries).toBe(0);
    const sent = mockOutbound();
    await runReminders(env, now + 3 * HOUR);
    expect(sent).toHaveLength(0);
  });
});

describe("request time zone", () => {
  it("shows the client page the zone the link was made in", async () => {
    const { cookie, req } = await ready();
    mockOutbound();
    await api("/api/firm", { method: "PATCH", cookie, body: { tz: "America/Vancouver" } });
    const { url } = await (await invite(cookie, req.id, {})).json<any>();
    const view = await (await api(`/api/c/${url.split("/c/")[1]}`)).json<any>();
    expect(view.tz).toBe("America/Vancouver");
    expect((await (await api("/api/me", { cookie })).json<any>()).firm.tz).toBe("America/Vancouver");
  });
});

describe("timezone setting", () => {
  it("takes a known zone and refuses others", async () => {
    const { cookie } = await setup();
    expect((await api("/api/firm", { method: "PATCH", cookie, body: { tz: "America/Vancouver" } })).status).toBe(200);
    expect((await (await api("/api/firm", { cookie })).json<any>()).tz).toBe("America/Vancouver");
    expect((await api("/api/firm", { method: "PATCH", cookie, body: { tz: "Mars/Base" } })).status).toBe(400);
    expect((await api("/api/firm", { method: "PATCH", cookie, body: { tz: 5 } })).status).toBe(400);
  });
});
