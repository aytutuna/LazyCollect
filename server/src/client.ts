import { Hono } from "hono";
import { rateLimited } from "./auth";
import { isRegion, regionOf } from "./regions";
import type { AppEnv } from "./session";
import { HOUR, hmac, ipPrefix, randomId } from "./util";
import { notFound } from "./validate";

export const client = new Hono<AppEnv>();

const TOKEN_RE = /^([a-z]+)_([\w-]{43})$/;

client.get("/c/:token", async (c) => {
  const ip = c.req.header("CF-Connecting-IP");
  if (await rateLimited(c.env, c.env.CLIENT, ip)) return c.json({ error: "rate_limited" }, 429);
  const match = TOKEN_RE.exec(c.req.param("token"));
  if (!match || !isRegion(match[1])) return notFound(c);
  const db = regionOf(c.env, match[1]).db;
  const hash = await hmac(c.env.HASH_KEY, match[2]);
  const now = Date.now();
  const req = await db
    .prepare(
      `SELECT r.id, r.firm_id, r.firm_name, r.title, r.note, r.deadline, r.status
       FROM links l JOIN requests r ON r.firm_id = l.firm_id AND r.id = l.request_id
       WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.expires_at > ?
       AND r.deleted_at IS NULL AND r.status != 'closed'`,
    )
    .bind(hash, now)
    .first<{ id: string; firm_id: string; firm_name: string; title: string; note: string | null; deadline: number; status: string }>();
  if (!req) return notFound(c);

  const { results } = await db
    .prepare("SELECT id, label, help, required, status, reject_note FROM items WHERE firm_id = ? AND request_id = ? ORDER BY position")
    .bind(req.firm_id, req.id)
    .all<{ required: number }>();
  await db
    .prepare(
      `INSERT INTO audit (id, firm_id, at, actor_type, action, object_type, object_id, ip_hash)
       SELECT ?, ?, ?, 'client', 'link.open', 'link', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM audit WHERE firm_id = ? AND object_type = 'link' AND object_id = ? AND action = 'link.open' AND at > ?)`,
    )
    .bind(randomId(), req.firm_id, now, hash, await hmac(c.env.HASH_KEY, ipPrefix(ip ?? "unknown")), req.firm_id, hash, now - HOUR)
    .run();
  return c.json({
    firm_name: req.firm_name,
    title: req.title,
    note: req.note,
    deadline: req.deadline,
    status: req.status,
    items: results.map((i) => ({ ...i, required: i.required === 1 })),
  });
});
