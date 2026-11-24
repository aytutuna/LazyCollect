import { Hono } from "hono";
import { auditClient } from "./audit";
import { rateLimited } from "./auth";
import { clientItems, linkOf } from "./client";
import { parseAnswer, visible, type Kind } from "./questions";
import type { AppEnv } from "./session";
import { syncStatus } from "./status";
import { nextReminder } from "./tz";
import { hmac, ipPrefix, keyLimited } from "./util";
import { invalid, notFound, readBody } from "./validate";

export const answers = new Hono<AppEnv>();

// A client's answer to a question item. It saves as they go, and sends back the items that apply now, since an answer can show or hide others.
answers.put("/c/:token/items/:itemId/answer", async (c) => {
  const ip = c.req.header("CF-Connecting-IP");
  if (await rateLimited(c.env, c.env.CLIENT, ip)) return c.json({ error: "rate_limited" }, 429);
  const link = await linkOf(c);
  if (!link || (link.req.status !== "open" && link.req.status !== "complete")) return notFound(c);
  if (await keyLimited(c.env.UPLOAD, link.hash)) return c.json({ error: "rate_limited" }, 429);
  const body = await readBody(c);
  if (!body || !("answer" in body)) return invalid(c);
  const { db, req } = link;
  const held = await db.prepare("SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND hold_at IS NOT NULL").bind(req.firm_id, req.id).first();
  if (held) return c.json({ error: "legal_hold" }, 409);
  const itemId = c.req.param("itemId") ?? "";
  const item = await db
    .prepare("SELECT kind, options_json FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND kind != 'file'")
    .bind(req.firm_id, req.id, itemId)
    .first<{ kind: Kind; options_json: string | null }>();
  if (!item) return notFound(c);
  const answer = parseAnswer(item.kind, item.options_json ? JSON.parse(item.options_json) : null, body.answer);
  if (answer === undefined) return invalid(c);

  const now = Date.now();
  const ipHash = await hmac(c.env.HASH_KEY, ipPrefix(ip ?? "unknown"));
  const mine = `firm_id = ? AND request_id = ? AND id = ? AND status != 'approved' AND ${visible("items")}`;
  const open = "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL AND hold_at IS NULL)";
  const binds = [req.firm_id, req.id, itemId, req.firm_id, req.id];
  // the audit row goes first: its condition reads the status the update changes; the answer itself is not logged
  const [, res] = await db.batch([
    auditClient(db, req.firm_id, ipHash, "item.answer", "item", itemId, { request: req.id }, { sql: `EXISTS (SELECT 1 FROM items WHERE ${mine}) AND ${open}`, binds }),
    db
      .prepare(`UPDATE items SET answer = ?, answer_at = ?, status = ? WHERE ${mine} AND ${open}`)
      .bind(answer, now, answer === null ? "empty" : "submitted", ...binds),
    syncStatus(db, req.firm_id, req.id),
    db
      .prepare(
        `UPDATE requests SET notice_due_at = COALESCE(notice_due_at, ?) WHERE firm_id = ? AND id = ?
         AND EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND id = ? AND answer_at = ? AND answer IS NOT NULL)`,
      )
      .bind(now, req.firm_id, req.id, req.firm_id, itemId, now),
    // a reopened request, or one with a newly shown question, picks its reminders up again
    db
      .prepare(
        `UPDATE requests SET next_reminder_at = ? WHERE firm_id = ? AND id = ? AND reminders_on = 1 AND status = 'open' AND deadline > ?
         AND (next_reminder_at IS NULL OR next_reminder_at <= ?)`,
      )
      .bind(nextReminder(now, req.deadline, req.tz ?? "America/Toronto", false), req.firm_id, req.id, now, now),
  ]);
  if (!res.meta.changes) return c.json({ error: "not_allowed" }, 409);
  return c.json({ items: await clientItems(db, req.firm_id, req.id) });
});
