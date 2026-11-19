import { escapeHtml, sendMail } from "./email";
import { isRegion, type Region } from "./regions";
import { MINUTE, hmac, randomId, sha256 } from "./util";

export const TEMPLATE_VERSION = 1;

const MAX_ATTEMPTS = 3;
const STALE = 30 * MINUTE;

export type Kind = "invite" | "reminder" | "deadline" | "rejected";
export type Missing = { label: string; required: boolean; reject_note: string | null };

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

// the display name sits inside quotes in a header, so nothing that could end or fold it survives
function senderName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f"<>\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
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
  }
}

function lists(l: Letter) {
  const line = (i: Missing) => (i.reject_note ? `${i.label} (sent back: ${i.reject_note})` : i.label);
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
      `Open your link to send them:\n${l.url}`,
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
${p(`<a href="${escapeHtml(l.url)}" style="display:inline-block;background:#1c5d99;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">Send your documents</a>`, "margin:0 0 24px")}
${p(`${escapeHtml(l.sender)}<br>${escapeHtml(l.address).replace(/\n/g, "<br>")}<br>${escapeHtml(reach)}`, small)}
${p(`${escapeHtml(why)} <a href="${escapeHtml(l.unsubUrl)}" style="color:#666666">Stop these emails</a>`, small)}
</div></body></html>`;
  return { subject, text, html };
}

export type Outcome = "sent" | "failed" | "done" | "busy" | "gave_up";

type Slot = { db: D1Database; firmId: string; requestId: string; clientId: string; kind: Kind; seq: number | null };

// The row goes in as 'sending' before the provider is called; the unique key lets only one run claim a slot.
export async function deliver(env: Env, slot: Slot, l: Letter, now = Date.now()): Promise<{ outcome: Outcome; seq: number }> {
  const { db, firmId, requestId, kind } = slot;
  const { subject, text, html } = render(l);
  const hash = await sha256(`${subject}\n${text}\n${html}`);
  const id = randomId();
  const inserted = await db
    .prepare(
      `INSERT INTO messages (id, firm_id, request_id, client_id, channel, kind, seq, template_version, body_hash, status, attempts, sent_at)
       SELECT ?1, ?2, ?3, ?4, 'email', ?5,
         COALESCE(?6, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE firm_id = ?2 AND request_id = ?3 AND kind = ?5 AND channel = 'email')),
         ?7, ?8, 'sending', 1, ?9
       WHERE true
       ON CONFLICT (firm_id, request_id, kind, seq, channel) DO NOTHING`,
    )
    .bind(id, firmId, requestId, slot.clientId, kind, slot.seq, TEMPLATE_VERSION, hash, now)
    .run();

  let messageId = id;
  let seq = slot.seq;
  if (inserted.meta.changes === 1) {
    seq ??= (await db.prepare("SELECT seq FROM messages WHERE id = ?").bind(id).first<{ seq: number }>())!.seq;
  } else {
    const retried = await db
      .prepare(
        `UPDATE messages SET status = 'sending', attempts = attempts + 1, body_hash = ?, error = NULL, sent_at = ?
         WHERE firm_id = ? AND request_id = ? AND kind = ? AND seq = ? AND channel = 'email' AND attempts < ${MAX_ATTEMPTS}
         AND (status = 'failed' OR (status = 'sending' AND sent_at < ?)) RETURNING id`,
      )
      .bind(hash, now, firmId, requestId, kind, slot.seq, now - STALE)
      .first<{ id: string }>();
    if (!retried) {
      const row = await db
        .prepare("SELECT status FROM messages WHERE firm_id = ? AND request_id = ? AND kind = ? AND seq = ? AND channel = 'email'")
        .bind(firmId, requestId, kind, slot.seq)
        .first<{ status: string }>();
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
      headers: { "List-Unsubscribe": `<${l.unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    await db.prepare("UPDATE messages SET status = 'sent', provider_id = ?, sent_at = ? WHERE id = ?").bind(providerId, now, messageId).run();
    return { outcome: "sent", seq: seq! };
  } catch (e) {
    const error = e instanceof Error ? e.message : "error";
    console.error(error);
    await db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").bind(error.slice(0, 200), messageId).run();
    return { outcome: "failed", seq: seq! };
  }
}

// The token is signed over the client and the account, so it needs no table and can't be pointed at another client.
async function sign(env: Env, region: string, clientId: string, firmId: string) {
  return (await hmac(env.HASH_KEY, `unsubscribe:${region}:${clientId}:${firmId}`)).slice(0, 32);
}

export async function unsubUrl(env: Env, region: Region, clientId: string, firmId: string): Promise<string> {
  return `${env.APP_URL}/u/${region}_${clientId}${firmId}${await sign(env, region, clientId, firmId)}`;
}

export async function readUnsubToken(env: Env, token: string): Promise<{ region: Region; clientId: string; firmId: string } | null> {
  const m = /^([a-z]+)_([0-9a-f]{32})([0-9a-f]{32})([0-9a-f]{32})$/.exec(token);
  if (!m || !isRegion(m[1])) return null;
  const expected = await sign(env, m[1], m[2], m[3]);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[4].charCodeAt(i);
  return diff === 0 ? { region: m[1], clientId: m[2], firmId: m[3] } : null;
}
