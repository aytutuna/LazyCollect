import { asLang } from "./lang";
import { Hono } from "hono";
import { audit, auditClient } from "./audit";
import { rateLimited } from "./auth";
import { linkOf, type LiveLink } from "./client";
import { liveToken } from "./links";
import { addressStopped, deliver, unsubUrl } from "./mail";
import type { Region } from "./regions";
import { findRequest } from "./requests";
import { canSend, senderName, sendersOf } from "./reminders";
import type { AppEnv } from "./session";
import { DAY, MINUTE, hmac, ipPrefix, keyLimited, randomId } from "./util";
import { invalid, notFound, readBody, text } from "./validate";

export const notes = new Hono<AppEnv>();

const MAX_LENGTH = 2000;
const CLIENT_PER_DAY = 20;
const CLIENT_PER_REQUEST = 200;
const USER_PER_REQUEST = 300;
const REPLY_QUIET = 30 * MINUTE;

const live = (link: LiveLink) => link.req.status === "open" || link.req.status === "complete";

// A client's question lands in the thread; the account hears about it in its next owner notice.
notes.post("/c/:token/notes", async (c) => {
  const ip = c.req.header("CF-Connecting-IP");
  if (await rateLimited(c.env, c.env.CLIENT, ip)) return c.json({ error: "rate_limited" }, 429);
  const link = await linkOf(c);
  if (!link || !live(link)) return notFound(c);
  if (await keyLimited(c.env.NOTE, link.hash)) return c.json({ error: "rate_limited" }, 429);
  const body = text((await readBody(c))?.body, MAX_LENGTH);
  if (!body) return invalid(c);

  const { db, req } = link;
  const id = randomId();
  const now = Date.now();
  const ipHash = await hmac(c.env.HASH_KEY, ipPrefix(ip ?? "unknown"));
  const mine = { sql: "EXISTS (SELECT 1 FROM notes WHERE firm_id = ? AND id = ?)", binds: [req.firm_id, id] };
  const [added] = await db.batch([
    db
      .prepare(
        `INSERT INTO notes (id, firm_id, request_id, author, body, created_at)
         SELECT ?, ?, ?, 'client', ?, ?
         WHERE EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL)
         AND EXISTS (SELECT 1 FROM links WHERE token_hash = ? AND revoked_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM firm_settings WHERE firm_id = ? AND closed_at IS NOT NULL)
         AND (SELECT COUNT(*) FROM notes WHERE firm_id = ? AND request_id = ? AND author = 'client' AND created_at > ?) < ${CLIENT_PER_DAY}
         AND (SELECT COUNT(*) FROM notes WHERE firm_id = ? AND request_id = ? AND author = 'client') < ${CLIENT_PER_REQUEST}`,
      )
      .bind(id, req.firm_id, req.id, body, now, req.firm_id, req.id, link.hash, req.firm_id, req.firm_id, req.id, now - DAY, req.firm_id, req.id),
    auditClient(db, req.firm_id, ipHash, "note.post", "note", id, { request: req.id }, mine),
    db
      .prepare("UPDATE requests SET notice_due_at = COALESCE(notice_due_at, ?) WHERE firm_id = ? AND id = ? AND EXISTS (SELECT 1 FROM notes WHERE firm_id = ? AND id = ?)")
      .bind(now, req.firm_id, req.id, req.firm_id, id),
  ]);
  if (!added.meta.changes) {
    const again = await linkOf(c);
    return again && live(again) ? c.json({ error: "too_many_notes" }, 429) : notFound(c);
  }
  return c.json({ id, author: "client", body, created_at: now }, 201);
});

// client notes after the account's last answer
const UNANSWERED = `(SELECT COUNT(*) FROM notes n WHERE n.firm_id = ?1 AND n.request_id = ?2 AND n.author = 'client'
  AND n.created_at > COALESCE((SELECT MAX(created_at) FROM notes WHERE firm_id = ?1 AND request_id = ?2 AND author = 'user'), 0))`;

// the newest 300, oldest first
export const NEWEST = `SELECT id, author, body, created_at FROM (SELECT rowid AS rid, id, author, body, created_at FROM notes WHERE firm_id = ? AND request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 300) ORDER BY created_at, rid`;

notes.get("/requests/:id/notes", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const [list, count] = await db.batch([
    db.prepare(NEWEST).bind(firmId, req.id),
    db.prepare(`SELECT ${UNANSWERED} AS n`).bind(firmId, req.id),
  ]);
  return c.json({ notes: list.results, unanswered: (count.results[0] as { n: number }).n });
});

notes.post("/requests/:id/notes", async (c) => {
  const body = text((await readBody(c))?.body, MAX_LENGTH);
  if (!body) return invalid(c);
  const req = await findRequest(c);
  if (!req) return notFound(c);
  if (req.status !== "open" && req.status !== "complete") return c.json({ error: "locked" }, 409);
  const db = c.get("db");
  const firm = c.get("firm");
  const id = randomId();
  const now = Date.now();
  const [added] = await db.batch([
    db
      .prepare(
        `INSERT INTO notes (id, firm_id, request_id, author, user_id, body, created_at) SELECT ?, ?, ?, 'user', ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL)
         AND (SELECT COUNT(*) FROM notes WHERE firm_id = ? AND request_id = ? AND author = 'user') < ${USER_PER_REQUEST}`,
      )
      .bind(id, firm.id, req.id, c.get("session")!.userId, body, now, firm.id, req.id, firm.id, req.id),
    audit(c, "note.answer", "note", id, { request: req.id }, { sql: "EXISTS (SELECT 1 FROM notes WHERE firm_id = ? AND id = ?)", binds: [firm.id, id] }),
  ]);
  if (!added.meta.changes) {
    const open = await findRequest(c);
    return open && (open.status === "open" || open.status === "complete") ? c.json({ error: "too_many_notes" }, 429) : c.json({ error: "locked" }, 409);
  }
  const note = { id, author: "user", body, created_at: now };

  // The reply is saved either way; the email says only that there is one, and is held to the same stops and caps as the rest.
  const mail = await emailReply(c.env, db, firm, req, now);
  return c.json({ note, emailed: mail === "sent", email: mail }, 201);
});

type Firm = { id: string; region: string; tz: string };

async function emailReply(env: Env, db: D1Database, firm: Firm, req: { id: string; client_id: string; locale: string; title: string; deadline: number }, now: number) {
  const region = firm.region as Region;
  const [sender] = (await sendersOf(env, region, [firm.id])).values();
  if (!canSend(sender, now)) return "not_set_up";
  const client = await db
    .prepare("SELECT name, email, email_ok_at, email_stop_at FROM clients WHERE firm_id = ? AND id = ? AND deleted_at IS NULL")
    .bind(firm.id, req.client_id)
    .first<{ name: string; email: string | null; email_ok_at: number | null; email_stop_at: number | null }>();
  if (!client?.email || !client.email_ok_at) return "no_email";
  if (client.email_stop_at || (await addressStopped(env, db, firm.id, client.email))) return "unsubscribed";
  const link = await liveToken(env, db, firm.id, req.id, now);
  if (!link) return "no_link";
  // a second reply soon after the first needs no second email, unless the client wrote in between: the first one points to the same thread
  const recent = await db
    .prepare(
      `SELECT 1 FROM messages m WHERE m.firm_id = ? AND m.request_id = ? AND m.kind = 'answer' AND m.status IN ('sent', 'sending') AND m.sent_at > ?
       AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.firm_id = m.firm_id AND n.request_id = m.request_id AND n.author = 'client' AND n.created_at > m.sent_at)`,
    )
    .bind(firm.id, req.id, now - REPLY_QUIET)
    .first();
  if (recent) return "recent";
  try {
    const { outcome } = await deliver(
      env,
      { db, firmId: firm.id, requestId: req.id, clientId: req.client_id, kind: "answer", seq: null },
      {
        kind: "answer",
        lang: asLang(req.locale),
        sender: senderName(sender),
        address: sender.address,
        phone: sender.phone,
        replyTo: sender.owner_email,
        clientName: client.name,
        clientEmail: client.email,
        title: req.title,
        deadline: req.deadline,
        tz: firm.tz,
        items: [],
        url: `${env.APP_URL}/c/${link.token}`,
        unsubUrl: await unsubUrl(env, region, req.client_id, firm.id, client.email),
      },
      now,
    );
    return outcome === "sent" ? "sent" : outcome === "capped" ? "email_limit" : "failed";
  } catch (e) {
    console.error(e instanceof Error ? e.message : "error");
    return "failed";
  }
}
