import { itemFailed } from "./pulse";
import { Transient, escapeHtml, sendMail } from "./email";
import { reasonLabels } from "./reasons";
import { isRegion, type Region } from "./regions";
import { DAY, MINUTE, hmac, randomId, sha256 } from "./util";

export const TEMPLATE_VERSION = 1;

// The cron numbers its reminders from 1 up, so one sent by hand lives in its own range of the same kinds. It then also counts
// toward the 36 hour spacing the cron keeps between emails to one client.
export const MANUAL_SEQ = 1_000_000;

const MAX_ATTEMPTS = 3;
const STALE = 30 * MINUTE;

// emails per account in any 24 hours, and invites per request; the shared sender key must not be a relay. Invitations (staff
// invitations too) are counted apart from reminders and notes, so a busy deadline week doesn't use up the room for new requests.
const TRIAL_DAILY = 50;
const PAID_DAILY = 500;
const TRIAL_NOTES = 200;
const PAID_NOTES = 2000;
const INVITES_PER_REQUEST = 3;

export type Kind = "invite" | "reminder" | "deadline" | "rejected" | "answer";
export type Missing = { label: string; required: boolean; reject_note: string | null; reject_reasons?: string | null };

export type Letter = {
  kind: Kind;
  sender: string;
  address: string;
  phone: string | null;
  replyTo: string;
  clientName: string;
  clientEmail: string;
  title: string;
  deadline: number;
  tz: string;
  items: Missing[];
  url: string;
  unsubUrl: string;
};

// the display name sits inside quotes in a header, so nothing that could end or fold it survives; commas go too, for parsers that split on them
function senderName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f"<>\\,]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export function fromHeader(env: Env, name: string): string {
  const address = /<([^>]+)>/.exec(env.EMAIL_FROM)?.[1] ?? env.EMAIL_FROM;
  return `"${senderName(name) || "Sender"} via Lazy Collect" <${address}>`;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

const SUBJECTS: Record<Kind, (l: Letter, date: string) => string> = {
  invite: (l) => `Documents requested: ${l.title}`,
  reminder: (l, date) => `Reminder: ${l.title}, due ${date}`,
  deadline: (l) => `Deadline passed: ${l.title}`,
  rejected: (l) => `Please resend: ${l.title}`,
  answer: (l) => `${l.sender} replied: ${l.title}`,
};

function intro(l: Letter, date: string): string {
  switch (l.kind) {
    case "invite":
      return `${l.sender} has asked you to send documents for "${l.title}". Please send them by ${date}.`;
    case "reminder":
      return `A reminder from ${l.sender}: documents for "${l.title}" are still needed. The deadline is ${date}.`;
    case "deadline":
      return `The deadline of ${date} for "${l.title}" has passed and some documents have not arrived. ${l.sender} can still accept them through the link below.`;
    case "rejected":
      return `${l.sender} looked at what you sent for "${l.title}" and needs a different file for the items below.`;
    case "answer":
      return `${l.sender} has replied to your message about "${l.title}". Open your link to read it.`;
  }
}

function lists(l: Letter) {
  const line = (i: Missing) => {
    const why = [...reasonLabels(i.reject_reasons ?? null), ...(i.reject_note ? [i.reject_note] : [])].join("; ");
    return why ? `${i.label} (sent back: ${why})` : i.label;
  };
  if (l.kind === "answer") return [];
  if (l.kind === "rejected") return [{ heading: "Please send again:", items: l.items.map(line) }];
  const needed = l.items.filter((i) => i.required).map(line);
  const maybe = l.items.filter((i) => !i.required).map(line);
  return [
    ...(needed.length ? [{ heading: "Still needed:", items: needed }] : []),
    ...(maybe.length ? [{ heading: "If they apply to you:", items: maybe }] : []),
  ];
}

export function render(l: Letter) {
  const date = new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: l.tz }).format(l.deadline);
  const subject = oneLine(SUBJECTS[l.kind](l, date));
  const reach = `Reply to this email to reach ${l.sender} at ${l.replyTo}${l.phone ? `, or call ${l.phone}` : ""}.`;
  const why = `You are getting this because ${l.sender} lists your email address as a contact for this request.`;
  const blocks = lists(l);

  const text =
    [
      `Hello ${l.clientName},`,
      intro(l, date),
      ...blocks.map((b) => `${b.heading}\n${b.items.map((i) => `- ${i}`).join("\n")}`),
      `${l.kind === "answer" ? "Open your link to read the reply" : "Open your link to send them"}:\n${l.url}`,
      `${l.sender}\n${l.address}\n${reach}`,
      `${why}\nStop these emails: ${l.unsubUrl}`,
    ].join("\n\n") + "\n";

  const p = (s: string, style = "margin:0 0 16px") => `<p style="${style}">${s}</p>`;
  const small = "font-size:13px;line-height:1.5;color:#666666;margin:0 0 12px";
  const list = (b: { heading: string; items: string[] }) =>
    `${p(`<b>${b.heading}</b>`, "margin:0 0 4px")}<ul style="margin:0 0 16px;padding-left:20px">${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;padding:24px 16px;background:#f6f6f4;font-family:Arial,sans-serif;color:#1c1c1c">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
${p(`Hello ${escapeHtml(l.clientName)},`)}
${p(escapeHtml(intro(l, date)))}
${blocks.map(list).join("\n")}
${p(`<a href="${escapeHtml(l.url)}" style="display:inline-block;background:#1c5d99;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">${l.kind === "answer" ? "Read the reply" : "Send your documents"}</a>`, "margin:0 0 24px")}
${p(`${escapeHtml(l.sender)}<br>${escapeHtml(l.address).replace(/\n/g, "<br>")}<br>${escapeHtml(reach)}`, small)}
${p(`${escapeHtml(why)} <a href="${escapeHtml(l.unsubUrl)}" style="color:#666666">Stop these emails</a>`, small)}
</div></body></html>`;
  return { subject, text, html };
}

// the key for an address in email_stops; clients' addresses are stored lowercased already
export const stopHash = (env: Env, email: string) => hmac(env.HASH_KEY, `email-stop:${email.trim().toLowerCase()}`);

export type Outcome = "sent" | "failed" | "later" | "done" | "busy" | "gave_up" | "capped";

type Slot = { db: D1Database; firmId: string; requestId: string; clientId: string; kind: Kind; seq: number | null };

// Counted inside the statement that claims the slot, so parallel sends can't pass a cap together; the slot itself is left out of the count.
const ROOM = `((SELECT COUNT(*) FROM messages WHERE firm_id = ?2 AND (kind = 'invite') = (?5 = 'invite') AND status IN ('sent', 'sending') AND sent_at > ?10 AND NOT (request_id = ?3 AND kind = ?5 AND seq IS ?6))
    + (SELECT COUNT(*) FROM staff_mail WHERE firm_id = ?2 AND sent_at > ?10 AND ?5 = 'invite')) < ?11
  AND (?5 != 'invite' OR (SELECT COUNT(*) FROM messages WHERE firm_id = ?2 AND request_id = ?3 AND kind = 'invite' AND status IN ('sent', 'sending') AND sent_at > ?10 AND seq IS NOT ?6) < ${INVITES_PER_REQUEST})`;

const dailyCap = (subscribed: string | null | undefined, kind: Kind) =>
  kind === "invite" ? (subscribed ? PAID_DAILY : TRIAL_DAILY) : subscribed ? PAID_NOTES : TRIAL_NOTES;

// A staff invite takes a slot under the same cap as the messages above; null when the account is out of room.
export async function claimStaffMail(env: Env, db: D1Database, firmId: string, now = Date.now()): Promise<string | null> {
  const paid = await env.CONTROL.prepare("SELECT stripe_subscription_id FROM firms WHERE id = ?").bind(firmId).first<{ stripe_subscription_id: string | null }>();
  const id = randomId();
  const res = await db
    .prepare(
      `INSERT INTO staff_mail (id, firm_id, sent_at) SELECT ?1, ?2, ?3
       WHERE ((SELECT COUNT(*) FROM messages WHERE firm_id = ?2 AND kind = 'invite' AND status IN ('sent', 'sending') AND sent_at > ?4)
         + (SELECT COUNT(*) FROM staff_mail WHERE firm_id = ?2 AND sent_at > ?4)) < ?5`,
    )
    .bind(id, firmId, now, now - DAY, dailyCap(paid?.stripe_subscription_id, "invite"))
    .run();
  return res.meta.changes === 1 ? id : null;
}

// A look before a link is rotated for an email; deliver still guards the slot itself for parallel sends.
export async function hasRoom(env: Env, db: D1Database, firmId: string, requestId: string, now = Date.now()): Promise<boolean> {
  const paid = await env.CONTROL.prepare("SELECT stripe_subscription_id FROM firms WHERE id = ?").bind(firmId).first<{ stripe_subscription_id: string | null }>();
  const r = (await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM messages WHERE firm_id = ?1 AND kind = 'invite' AND status IN ('sent', 'sending') AND sent_at > ?3)
         + (SELECT COUNT(*) FROM staff_mail WHERE firm_id = ?1 AND sent_at > ?3) AS day,
       (SELECT COUNT(*) FROM messages WHERE firm_id = ?1 AND request_id = ?2 AND kind = 'invite' AND status IN ('sent', 'sending') AND sent_at > ?3) AS invites`,
    )
    .bind(firmId, requestId, now - DAY)
    .first<{ day: number; invites: number }>())!;
  return r.day < dailyCap(paid?.stripe_subscription_id, "invite") && r.invites < INVITES_PER_REQUEST;
}

// The row goes in as 'sending' before the provider is called; the unique key lets only one run claim a slot.
export async function deliver(env: Env, slot: Slot, l: Letter, now = Date.now()): Promise<{ outcome: Outcome; seq: number }> {
  const { db, firmId, requestId, kind } = slot;
  const { subject, text, html } = render(l);
  const hash = await sha256(`${subject}\n${text}\n${html}`);
  const id = randomId();
  const paid = await env.CONTROL.prepare("SELECT stripe_subscription_id FROM firms WHERE id = ?").bind(firmId).first<{ stripe_subscription_id: string | null }>();
  // both statements below read the same numbered values
  const args = [id, firmId, requestId, slot.clientId, kind, slot.seq, TEMPLATE_VERSION, hash, now, now - DAY, dailyCap(paid?.stripe_subscription_id, kind), now - STALE];
  const inserted = await db
    .prepare(
      `INSERT INTO messages (id, firm_id, request_id, client_id, channel, kind, seq, template_version, body_hash, status, attempts, sent_at)
       SELECT ?1, ?2, ?3, ?4, 'email', ?5,
         COALESCE(?6, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE firm_id = ?2 AND request_id = ?3 AND kind = ?5 AND channel = 'email')),
         ?7, ?8, 'sending', 1, ?9
       WHERE ${ROOM}
       ON CONFLICT (firm_id, request_id, kind, seq, channel) DO NOTHING`,
    )
    .bind(...args.slice(0, 11))
    .run();

  let messageId = id;
  let seq = slot.seq;
  if (inserted.meta.changes === 1) {
    seq ??= (await db.prepare("SELECT seq FROM messages WHERE id = ?").bind(id).first<{ seq: number }>())!.seq;
  } else {
    const retried = await db
      .prepare(
        `UPDATE messages SET status = 'sending', attempts = attempts + 1, body_hash = ?8, error = NULL, sent_at = ?9
         WHERE firm_id = ?2 AND request_id = ?3 AND kind = ?5 AND seq = ?6 AND channel = 'email' AND attempts < ${MAX_ATTEMPTS}
         AND (status = 'failed' OR (status = 'sending' AND sent_at < ?12)) AND ${ROOM} RETURNING id`,
      )
      .bind(...args)
      .first<{ id: string }>();
    if (!retried) {
      // a last attempt that never reported back is given up on, or its request would stay due forever
      await db
        .prepare(
          `UPDATE messages SET status = 'failed', error = 'no result' WHERE firm_id = ? AND request_id = ? AND kind = ? AND seq = ? AND channel = 'email'
           AND status = 'sending' AND attempts >= ${MAX_ATTEMPTS} AND sent_at < ?`,
        )
        .bind(firmId, requestId, kind, slot.seq, now - STALE)
        .run();
      const row = await db
        .prepare("SELECT status, attempts, sent_at FROM messages WHERE firm_id = ? AND request_id = ? AND kind = ? AND seq = ? AND channel = 'email'")
        .bind(firmId, requestId, kind, slot.seq)
        .first<{ status: string; attempts: number; sent_at: number }>();
      // nothing was inserted, or a row that could have been tried again was left alone: only the cap says no to those
      if (!row || (row.attempts < MAX_ATTEMPTS && (row.status === "failed" || (row.status === "sending" && row.sent_at < now - STALE)))) {
        return { outcome: "capped", seq: slot.seq! };
      }
      const outcome = row?.status === "sent" ? "done" : row?.status === "failed" ? "gave_up" : "busy";
      return { outcome, seq: slot.seq! };
    }
    messageId = retried.id;
  }

  try {
    const providerId = await sendMail(env, {
      from: fromHeader(env, l.sender),
      to: l.clientEmail,
      replyTo: l.replyTo,
      subject,
      text,
      html,
      idempotencyKey: `${firmId}:${requestId}:${kind}:${seq}`,
      headers: { "List-Unsubscribe": `<${l.unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    await db.prepare("UPDATE messages SET status = 'sent', provider_id = ?, sent_at = ? WHERE id = ?").bind(providerId, now, messageId).run();
    return { outcome: "sent", seq: seq! };
  } catch (e) {
    const error = e instanceof Error ? e.message : "error";
    console.error(error);
    // a busy provider does not use up one of the attempts
    const later = e instanceof Transient;
    itemFailed(later ? "EmailDeferred" : "EmailRefused");
    await db
      .prepare("UPDATE messages SET status = 'failed', error = ?, attempts = attempts - ? WHERE id = ?")
      .bind(error.slice(0, 200), later ? 1 : 0, messageId)
      .run();
    return { outcome: later ? "later" : "failed", seq: seq! };
  }
}

// The token is signed over the client, the account and the address the email went to, so it needs no table and can't be
// pointed at another client. Tokens in emails sent before the address was added are shorter and carry none.
async function sign(env: Env, region: string, clientId: string, firmId: string, hash: string | null) {
  return (await hmac(env.HASH_KEY, `unsubscribe:${region}:${clientId}:${firmId}${hash ? `:${hash}` : ""}`)).slice(0, 32);
}

export async function unsubUrl(env: Env, region: Region, clientId: string, firmId: string, email: string): Promise<string> {
  const hash = await stopHash(env, email);
  return `${env.APP_URL}/u/${region}_${clientId}${firmId}${hash}${await sign(env, region, clientId, firmId, hash)}`;
}

export async function readUnsubToken(env: Env, token: string): Promise<{ region: Region; clientId: string; firmId: string; hash: string | null } | null> {
  const m = /^([a-z]+)_([0-9a-f]{32})([0-9a-f]{32})([0-9a-f]{64})?([0-9a-f]{32})$/.exec(token);
  if (!m || !isRegion(m[1])) return null;
  const expected = await sign(env, m[1], m[2], m[3], m[4] ?? null);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[5].charCodeAt(i);
  return diff === 0 ? { region: m[1], clientId: m[2], firmId: m[3], hash: m[4] ?? null } : null;
}

// Stops recorded before email_stops existed sit only on a client row, deleted ones included. Finding one writes the
// missing row, so each address is looked up this way once.
export async function addressStopped(env: Env, db: D1Database, firmId: string, email: string): Promise<boolean> {
  const hash = await stopHash(env, email);
  const [kept, old] = await db.batch([
    db.prepare("SELECT 1 FROM email_stops WHERE firm_id = ? AND email_hash = ?").bind(firmId, hash),
    db.prepare("SELECT MIN(email_stop_at) AS at FROM clients WHERE firm_id = ? AND lower(email) = ? AND email_stop_at IS NOT NULL").bind(firmId, email.trim().toLowerCase()),
  ]);
  if (kept.results.length) return true;
  const at = (old.results[0] as { at: number | null }).at;
  if (at === null) return false;
  await db.prepare("INSERT OR IGNORE INTO email_stops (firm_id, email_hash, stopped_at) VALUES (?, ?, ?)").bind(firmId, hash, at).run();
  return true;
}
