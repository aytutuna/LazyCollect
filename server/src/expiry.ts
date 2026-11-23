import { Hono } from "hono";
import { auditClient } from "./audit";
import { rateLimited } from "./auth";
import { clientItems, findLink } from "./client";
import { validTo, visible, parseDay } from "./questions";
import type { AppEnv } from "./session";
import { addDays, dayOf, isoDay, offsetAt } from "./tz";
import { hmac, ipPrefix, keyLimited } from "./util";
import { invalid, notFound, readBody } from "./validate";

export const SOON_DAYS = 90;
const COUNTED = "'submitted', 'approved'";

// the dates the flags are measured against, in the account's zone
export function today(now: number, tz: string) {
  const day = dayOf(now, tz);
  return { today: isoDay(day), soon: isoDay(addDays(day, SOON_DAYS)), offset: offsetAt(now, tz) };
}

// SQL: the calendar day of a request's deadline, which is set as the end of a day in the account's zone, so the middle of that day is used
export const deadlineDay = (r: string, offset: number) => `date((${r}.deadline + ${offset} - 43200000) / 1000, 'unixepoch')`;

// SQL: the date a document must stay valid until. A document that counts from its issue date is held to the deadline, one with an expiry date to the request's own date.
export const mustLast = (i: string, r: string, offset: number) =>
  `CASE ${i}.expiry_rule WHEN 'issue' THEN ${deadlineDay(r, offset)} ELSE COALESCE(${r}.valid_until, date(${deadlineDay(r, offset)}, '+6 months')) END`;

export type Flag = "expired" | "short" | "soon";

export function flagOf(item: { status: string; hidden: boolean; valid_to: string | null }, target: string, now: { today: string; soon: string }): Flag | null {
  if (!item.valid_to || item.hidden || (item.status !== "submitted" && item.status !== "approved")) return null;
  if (item.valid_to < now.today) return "expired";
  if (item.valid_to < target) return "short";
  return item.valid_to <= now.soon ? "soon" : null;
}

// SQL: the item `i` of request `r` has a date that is past, before the date it must last to, or close
export const expiring = (i: string, r: string, now: { soon: string; offset: number }) =>
  `(${i}.expiry_rule IS NOT NULL AND ${i}.status IN (${COUNTED}) AND ${visible(i)} AND (${validTo(i)}) IS NOT NULL
    AND ((${validTo(i)}) <= '${now.soon}' OR (${validTo(i)}) < (${mustLast(i, r, now.offset)})))`;

export const dates = new Hono<AppEnv>();

// The client gives the date of a document next to its upload; it saves as they go, like an answer.
dates.put("/c/:token/items/:itemId/dates", async (c) => {
  const ip = c.req.header("CF-Connecting-IP");
  if (await rateLimited(c.env, c.env.CLIENT, ip)) return c.json({ error: "rate_limited" }, 429);
  const link = await findLink(c.env, c.req.param("token") ?? "");
  if (!link || (link.req.status !== "open" && link.req.status !== "complete")) return notFound(c);
  if (await keyLimited(c.env.UPLOAD, link.hash)) return c.json({ error: "rate_limited" }, 429);
  const body = await readBody(c);
  const expires = body && "expires_on" in body ? parseDay(body.expires_on) : null;
  const issued = body && "issued_on" in body ? parseDay(body.issued_on) : null;
  if (!body || expires === undefined || issued === undefined || !("expires_on" in body || "issued_on" in body)) return invalid(c);
  const { db, req } = link;
  const itemId = c.req.param("itemId") ?? "";
  const held = await db.prepare("SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND hold_at IS NOT NULL").bind(req.firm_id, req.id).first();
  if (held) return c.json({ error: "legal_hold" }, 409);

  const sets = [...("expires_on" in body ? ["expires_on = ?"] : []), ...("issued_on" in body ? ["issued_on = ?"] : [])];
  const values = [...("expires_on" in body ? [expires] : []), ...("issued_on" in body ? [issued] : [])];
  const mine = `firm_id = ? AND request_id = ? AND id = ? AND expiry_rule IS NOT NULL AND status != 'approved' AND ${visible("items")}`;
  const open = "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL AND hold_at IS NULL)";
  const binds = [req.firm_id, req.id, itemId, req.firm_id, req.id];
  const ipHash = await hmac(c.env.HASH_KEY, ipPrefix(ip ?? "unknown"));
  const [, res] = await db.batch([
    auditClient(db, req.firm_id, ipHash, "item.dates", "item", itemId, { request: req.id }, { sql: `EXISTS (SELECT 1 FROM items WHERE ${mine}) AND ${open}`, binds }),
    db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE ${mine} AND ${open}`).bind(...values, ...binds),
  ]);
  if (!res.meta.changes) return c.json({ error: "not_allowed" }, 409);
  return c.json({ items: await clientItems(db, req.firm_id, req.id) });
});
