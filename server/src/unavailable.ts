import { Hono, type Context } from "hono";
import { audit, auditClient } from "./audit";
import { rateLimited } from "./auth";
import { linkOf } from "./client";
import { presentItem, ITEM_COLS } from "./questions";
import { findRequest } from "./requests";
import type { AppEnv } from "./session";
import { syncStatus } from "./status";
import { nextReminder } from "./tz";
import { hmac, ipPrefix, keyLimited } from "./util";
import { invalid, maybe, notFound, readBody, text } from "./validate";

export const unavailable = new Hono<AppEnv>();

const OPEN = "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL)";

// A client with no such document says so (and can take it back); the account then accepts that or asks again.
async function clientSide(c: Context<AppEnv>, mark: boolean) {
  const ip = c.req.header("CF-Connecting-IP");
  if (await rateLimited(c.env, c.env.CLIENT, ip)) return c.json({ error: "rate_limited" }, 429);
  const link = await linkOf(c);
  if (!link || (link.req.status !== "open" && link.req.status !== "complete")) return notFound(c);
  if (await keyLimited(c.env.UPLOAD, link.hash)) return c.json({ error: "rate_limited" }, 429);
  let note: string | null = null;
  if (mark) {
    const given = maybe((await readBody(c))?.note, 500);
    if (given === undefined) return invalid(c);
    note = given;
  }
  const { db, req } = link;
  const itemId = c.req.param("itemId") ?? "";
  const now = Date.now();
  const ipHash = await hmac(c.env.HASH_KEY, ipPrefix(ip ?? "unknown"));
  const from = mark ? "'empty', 'rejected'" : "'unavailable'";
  const here = [req.firm_id, req.id, itemId];
  const ready = `EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND kind = 'file' AND status IN (${from})) AND ${OPEN}`;
  const readyBinds = [...here, req.firm_id, req.id];
  // the audit row goes first: its condition reads the status the update changes
  const [, res] = await db.batch([
    auditClient(db, req.firm_id, ipHash, mark ? "item.unavailable" : "item.available", "item", itemId, { request: req.id }, { sql: ready, binds: readyBinds }),
    mark
      ? db
          .prepare(`UPDATE items SET status = 'unavailable', unavailable_note = ?, unavailable_at = ? WHERE firm_id = ? AND request_id = ? AND id = ? AND kind = 'file' AND status IN (${from}) AND ${OPEN}`)
          .bind(note, now, ...readyBinds)
      : db
          .prepare(
            `UPDATE items SET unavailable_note = NULL, unavailable_at = NULL,
               status = CASE
                 WHEN EXISTS (SELECT 1 FROM files WHERE firm_id = items.firm_id AND item_id = items.id AND state = 'live' AND deleted_at IS NULL AND uploaded_at > COALESCE(items.reviewed_at, 0)) THEN 'submitted'
                 WHEN reject_note IS NOT NULL OR reject_reasons IS NOT NULL THEN 'rejected'
                 ELSE 'empty' END
             WHERE firm_id = ? AND request_id = ? AND id = ? AND kind = 'file' AND status IN (${from}) AND ${OPEN}`,
          )
          .bind(...readyBinds),
    syncStatus(db, req.firm_id, req.id),
    // the account hears about it in the next owner notice
    db
      .prepare("UPDATE requests SET notice_due_at = COALESCE(notice_due_at, ?) WHERE firm_id = ? AND id = ? AND ? = 1")
      .bind(now, req.firm_id, req.id, mark ? 1 : 0),
    // an item that was only waiting for an answer may have ended the cadence; taking it back starts it again
    db
      .prepare(
        `UPDATE requests SET next_reminder_at = ? WHERE firm_id = ? AND id = ? AND ? = 0 AND reminders_on = 1 AND status = 'open' AND deadline > ?
         AND (next_reminder_at IS NULL OR next_reminder_at <= ?)`,
      )
      .bind(nextReminder(now, req.deadline, req.tz ?? "America/Toronto", false), req.firm_id, req.id, mark ? 1 : 0, now, now),
  ]);
  if (!res.meta.changes) {
    const item = await db.prepare("SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ?").bind(...here).first();
    return item ? c.json({ error: "not_allowed" }, 409) : notFound(c);
  }
  const row = await db.prepare("SELECT id, status FROM items WHERE id = ?").bind(itemId).first();
  return c.json(row);
}

unavailable.post("/c/:token/items/:itemId/unavailable", (c) => clientSide(c, true));
unavailable.delete("/c/:token/items/:itemId/unavailable", (c) => clientSide(c, false));

unavailable.post("/requests/:id/items/:itemId/unavailable", async (c) => {
  const body = await readBody(c);
  if (!body || (body.decision !== "accept" && body.decision !== "ask")) return invalid(c);
  const accept = body.decision === "accept";
  const note = accept ? null : text(body.note, 500);
  if (!accept && !note) return invalid(c);
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const itemId = c.req.param("itemId");
  const ready = `EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND status = 'unavailable')
    AND EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL)`;
  const binds = [firmId, req.id, itemId, firmId, req.id];
  const at = Date.now();
  const [, res] = await db.batch([
    audit(c, accept ? "item.waive" : "item.ask_again", "item", itemId, { request: req.id }, { sql: ready, binds }),
    db
      .prepare(`UPDATE items SET status = ?, reject_note = ?, reject_reasons = NULL, reviewed_by = ?, reviewed_at = ? WHERE firm_id = ? AND request_id = ? AND id = ? AND ${ready}`)
      .bind(accept ? "waived" : "rejected", note, c.get("session")!.userId, at, firmId, req.id, itemId, ...binds),
    syncStatus(db, firmId, req.id),
    ...(accept
      ? []
      : [
          // like a sent-back document: the client hears once the account stops sending things back
          db
            .prepare(
              `UPDATE requests SET reject_mark_at = ? WHERE firm_id = ? AND id = ?
               AND EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND status = 'rejected' AND reviewed_at = ?)`,
            )
            .bind(at, firmId, req.id, firmId, req.id, itemId, at),
          // an item that was only waiting for this answer may have ended the cadence, so it starts again
          db
            .prepare(
              `UPDATE requests SET next_reminder_at = ? WHERE firm_id = ? AND id = ? AND reminders_on = 1 AND status = 'open' AND deadline > ?
               AND (next_reminder_at IS NULL OR next_reminder_at <= ?)`,
            )
            .bind(nextReminder(at, req.deadline, c.get("firm").tz, false), firmId, req.id, at, at),
        ]),
  ]);
  if (!res.meta.changes) {
    const item = await db.prepare("SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ?").bind(firmId, req.id, itemId).first();
    return item ? c.json({ error: "stale" }, 409) : notFound(c);
  }
  const row = await db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`).bind(itemId).first<any>();
  return c.json(presentItem(row));
});
