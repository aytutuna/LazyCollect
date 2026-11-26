import { itemFailed } from "./pulse";
import { Transient, escapeHtml, sendMail } from "./email";
import { longDate, type Lang } from "./lang";
import { reasonLabels } from "./reasons";
import { isRegion, type Region } from "./regions";
import { DAY, MINUTE, PAYING, hmac, randomId, sha256 } from "./util";

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
  lang: Lang;
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

export function fromHeader(env: Env, name: string, lang: Lang = "en"): string {
  const address = /<([^>]+)>/.exec(env.EMAIL_FROM)?.[1] ?? env.EMAIL_FROM;
  return `"${senderName(name) || WORDS[lang].fallbackSender} via Lazy Collect" <${address}>`;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

type Words = {
  hello: (name: string) => string;
  subject: Record<Kind, (l: Letter, date: string) => string>;
  intro: Record<Kind, (l: Letter, date: string) => string>;
  sentBack: string;
  sendAgain: string;
  stillNeeded: string;
  ifTheyApply: string;
  open: { answer: string; files: string };
  button: { answer: string; files: string };
  reach: (l: Letter) => string;
  why: (l: Letter) => string;
  stop: string;
  fallbackSender: string;
};

const WORDS: Record<Lang, Words> = {
  en: {
    hello: (name) => `Hello ${name},`,
    subject: {
      invite: (l) => `Documents requested: ${l.title}`,
      reminder: (l, date) => `Reminder: ${l.title}, due ${date}`,
      deadline: (l) => `Deadline passed: ${l.title}`,
      rejected: (l) => `Please resend: ${l.title}`,
      answer: (l) => `${l.sender} replied: ${l.title}`,
    },
    intro: {
      invite: (l, date) => `${l.sender} has asked you to send documents for "${l.title}". Please send them by ${date}.`,
      reminder: (l, date) => `A reminder from ${l.sender}: documents for "${l.title}" are still needed. The deadline is ${date}.`,
      deadline: (l, date) => `The deadline of ${date} for "${l.title}" has passed and some documents have not arrived. ${l.sender} can still accept them through the link below.`,
      rejected: (l) => `${l.sender} looked at what you sent for "${l.title}" and needs a different file for the items below.`,
      answer: (l) => `${l.sender} has replied to your message about "${l.title}". Open your link to read it.`,
    },
    sentBack: "sent back",
    sendAgain: "Please send again:",
    stillNeeded: "Still needed:",
    ifTheyApply: "If they apply to you:",
    open: { answer: "Open your link to read the reply", files: "Open your link to send them" },
    button: { answer: "Read the reply", files: "Send your documents" },
    reach: (l) => `Reply to this email to reach ${l.sender} at ${l.replyTo}${l.phone ? `, or call ${l.phone}` : ""}.`,
    why: (l) => `You are getting this because ${l.sender} lists your email address as a contact for this request.`,
    stop: "Stop these emails",
    fallbackSender: "Sender",
  },
  "fr-CA": {
    hello: (name) => `Bonjour ${name},`,
    subject: {
      invite: (l) => `Documents demandés : ${l.title}`,
      reminder: (l, date) => `Rappel : ${l.title}, à remettre le ${date}`,
      deadline: (l) => `Date limite dépassée : ${l.title}`,
      rejected: (l) => `Veuillez renvoyer : ${l.title}`,
      answer: (l) => `${l.sender} a répondu : ${l.title}`,
    },
    intro: {
      invite: (l, date) => `${l.sender} vous demande d'envoyer des documents pour « ${l.title} ». Veuillez les envoyer d'ici le ${date}.`,
      reminder: (l, date) => `Rappel de ${l.sender} : des documents pour « ${l.title} » sont toujours attendus. La date limite est le ${date}.`,
      deadline: (l, date) => `La date limite du ${date} pour « ${l.title} » est passée et certains documents ne sont pas arrivés. ${l.sender} peut encore les accepter au moyen du lien ci-dessous.`,
      rejected: (l) => `${l.sender} a examiné ce que vous avez envoyé pour « ${l.title} » et a besoin d'un autre fichier pour les éléments ci-dessous.`,
      answer: (l) => `${l.sender} a répondu à votre message au sujet de « ${l.title} ». Ouvrez votre lien pour le lire.`,
    },
    sentBack: "renvoyé",
    sendAgain: "À renvoyer :",
    stillNeeded: "Toujours requis :",
    ifTheyApply: "S'ils s'appliquent à vous :",
    open: { answer: "Ouvrez votre lien pour lire la réponse", files: "Ouvrez votre lien pour les envoyer" },
    button: { answer: "Lire la réponse", files: "Envoyer vos documents" },
    reach: (l) => `Répondez à ce courriel pour joindre ${l.sender} à ${l.replyTo}${l.phone ? `, ou téléphonez au ${l.phone}` : ""}.`,
    why: (l) => `Vous recevez ce message parce que ${l.sender} a inscrit votre adresse courriel comme contact pour cette demande.`,
    stop: "Ne plus recevoir ces courriels",
    fallbackSender: "Expéditeur",
  },
};

function lists(l: Letter, w: Words) {
  const line = (i: Missing) => {
    const why = [...reasonLabels(i.reject_reasons ?? null, l.lang), ...(i.reject_note ? [i.reject_note] : [])].join("; ");
    return why ? `${i.label} (${w.sentBack}${l.lang === "en" ? ": " : " : "}${why})` : i.label;
  };
  if (l.kind === "answer") return [];
  if (l.kind === "rejected") return [{ heading: w.sendAgain, items: l.items.map(line) }];
  const needed = l.items.filter((i) => i.required).map(line);
  const maybe = l.items.filter((i) => !i.required).map(line);
  return [
    ...(needed.length ? [{ heading: w.stillNeeded, items: needed }] : []),
    ...(maybe.length ? [{ heading: w.ifTheyApply, items: maybe }] : []),
  ];
}

export function render(l: Letter) {
  const w = WORDS[l.lang];
  const date = longDate(l.deadline, l.lang, l.tz);
  const subject = oneLine(w.subject[l.kind](l, date));
  const reach = w.reach(l);
  const why = w.why(l);
  const blocks = lists(l, w);
  // French puts a space before a colon
  const colon = l.lang === "en" ? ":" : " :";
  // the page the link opens speaks the language of the email
  const unsubUrl = `${l.unsubUrl}?lang=${l.lang}`;

  const text =
    [
      w.hello(l.clientName),
      w.intro[l.kind](l, date),
      ...blocks.map((b) => `${b.heading}\n${b.items.map((i) => `- ${i}`).join("\n")}`),
      `${l.kind === "answer" ? w.open.answer : w.open.files}${colon}\n${l.url}`,
      `${l.sender}\n${l.address}\n${reach}`,
      `${why}\n${w.stop}${colon} ${unsubUrl}`,
    ].join("\n\n") + "\n";

  const p = (s: string, style = "margin:0 0 16px") => `<p style="${style}">${s}</p>`;
  const small = "font-size:13px;line-height:1.5;color:#666666;margin:0 0 12px";
  const list = (b: { heading: string; items: string[] }) =>
    `${p(`<b>${b.heading}</b>`, "margin:0 0 4px")}<ul style="margin:0 0 16px;padding-left:20px">${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
  const html = `<!doctype html><html lang="${l.lang}"><body style="margin:0;padding:24px 16px;background:#f6f6f4;font-family:Arial,sans-serif;color:#1c1c1c">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
${p(escapeHtml(w.hello(l.clientName)))}
${p(escapeHtml(w.intro[l.kind](l, date)))}
${blocks.map(list).join("\n")}
${p(`<a href="${escapeHtml(l.url)}" style="display:inline-block;background:#1c5d99;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">${l.kind === "answer" ? w.button.answer : w.button.files}</a>`, "margin:0 0 24px")}
${p(`${escapeHtml(l.sender)}<br>${escapeHtml(l.address).replace(/\n/g, "<br>")}<br>${escapeHtml(reach)}`, small)}
${p(`${escapeHtml(why)} <a href="${escapeHtml(unsubUrl)}" style="color:#666666">${w.stop}</a>`, small)}
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

const dailyCap = (subscribed: number | null | undefined, kind: Kind) =>
  kind === "invite" ? (subscribed ? PAID_DAILY : TRIAL_DAILY) : subscribed ? PAID_NOTES : TRIAL_NOTES;

// A staff invite takes a slot under the same cap as the messages above; null when the account is out of room.
export async function claimStaffMail(env: Env, db: D1Database, firmId: string, now = Date.now()): Promise<string | null> {
  const paid = await env.CONTROL.prepare(`SELECT ${PAYING} AS paid FROM firms WHERE id = ?`).bind(firmId).first<{ paid: number }>();
  const id = randomId();
  const res = await db
    .prepare(
      `INSERT INTO staff_mail (id, firm_id, sent_at) SELECT ?1, ?2, ?3
       WHERE ((SELECT COUNT(*) FROM messages WHERE firm_id = ?2 AND kind = 'invite' AND status IN ('sent', 'sending') AND sent_at > ?4)
         + (SELECT COUNT(*) FROM staff_mail WHERE firm_id = ?2 AND sent_at > ?4)) < ?5`,
    )
    .bind(id, firmId, now, now - DAY, dailyCap(paid?.paid, "invite"))
    .run();
  return res.meta.changes === 1 ? id : null;
}

// A look before a link is rotated for an email; deliver still guards the slot itself for parallel sends.
export async function hasRoom(env: Env, db: D1Database, firmId: string, requestId: string, now = Date.now()): Promise<boolean> {
  const paid = await env.CONTROL.prepare(`SELECT ${PAYING} AS paid FROM firms WHERE id = ?`).bind(firmId).first<{ paid: number }>();
  const r = (await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM messages WHERE firm_id = ?1 AND kind = 'invite' AND status IN ('sent', 'sending') AND sent_at > ?3)
         + (SELECT COUNT(*) FROM staff_mail WHERE firm_id = ?1 AND sent_at > ?3) AS day,
       (SELECT COUNT(*) FROM messages WHERE firm_id = ?1 AND request_id = ?2 AND kind = 'invite' AND status IN ('sent', 'sending') AND sent_at > ?3) AS invites`,
    )
    .bind(firmId, requestId, now - DAY)
    .first<{ day: number; invites: number }>())!;
  return r.day < dailyCap(paid?.paid, "invite") && r.invites < INVITES_PER_REQUEST;
}

// The row goes in as 'sending' before the provider is called; the unique key lets only one run claim a slot.
export async function deliver(env: Env, slot: Slot, l: Letter, now = Date.now()): Promise<{ outcome: Outcome; seq: number }> {
  const { db, firmId, requestId, kind } = slot;
  const { subject, text, html } = render(l);
  const hash = await sha256(`${subject}\n${text}\n${html}`);
  const id = randomId();
  const paid = await env.CONTROL.prepare(`SELECT ${PAYING} AS paid FROM firms WHERE id = ?`).bind(firmId).first<{ paid: number }>();
  // both statements below read the same numbered values
  const args = [id, firmId, requestId, slot.clientId, kind, slot.seq, TEMPLATE_VERSION, hash, now, now - DAY, dailyCap(paid?.paid, kind), now - STALE];
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
      from: fromHeader(env, l.sender, l.lang),
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
