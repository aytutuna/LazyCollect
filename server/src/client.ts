import { Hono } from "hono";
import { rateLimited } from "./auth";
import { isRegion, regionOf, type Region } from "./regions";
import { NEWEST } from "./notes";
import { canSend, sendersOf } from "./reminders";
import type { AppEnv } from "./session";
import { HOUR, hmac, ipPrefix, randomId } from "./util";
import { notFound } from "./validate";

export const client = new Hono<AppEnv>();

const TOKEN_RE = /^([a-z]+)_([\w-]{43})$/;

export type LiveLink = {
  region: Region;
  db: D1Database;
  hash: string;
  req: { id: string; firm_id: string; firm_name: string; tz: string | null; title: string; note: string | null; deadline: number; status: string; expires_at: number };
};

export async function findLink(env: Env, token: string): Promise<LiveLink | null> {
  const match = TOKEN_RE.exec(token);
  if (!match || !isRegion(match[1])) return null;
  const region = match[1];
  const db = regionOf(env, region).db;
  const hash = await hmac(env.HASH_KEY, match[2]);
  const req = await db
    .prepare(
      `SELECT r.id, r.firm_id, r.firm_name, r.tz, r.title, r.note, r.deadline, r.status, l.expires_at
       FROM links l JOIN requests r ON r.firm_id = l.firm_id AND r.id = l.request_id
       JOIN clients cl ON cl.firm_id = r.firm_id AND cl.id = r.client_id AND cl.deleted_at IS NULL
       WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.expires_at > ?
       AND r.deleted_at IS NULL AND r.status != 'closed'
       AND NOT EXISTS (SELECT 1 FROM firm_settings fs WHERE fs.firm_id = r.firm_id AND fs.closed_at IS NOT NULL)`,
    )
    .bind(hash, Date.now())
    .first<LiveLink["req"]>();
  return req ? { region, db, hash, req } : null;
}

client.get("/c/:token", async (c) => {
  const ip = c.req.header("CF-Connecting-IP");
  if (await rateLimited(c.env, c.env.CLIENT, ip)) return c.json({ error: "rate_limited" }, 429);
  const link = await findLink(c.env, c.req.param("token"));
  if (!link) return notFound(c);
  const { db, hash, req } = link;
  const now = Date.now();

  const { results } = await db
    .prepare("SELECT id, label, help, required, status, reject_note, unavailable_note FROM items WHERE firm_id = ? AND request_id = ? ORDER BY position")
    .bind(req.firm_id, req.id)
    .all<{ id: string; required: number }>();
  const { results: files } = await db
    .prepare("SELECT id, item_id, name, size, uploaded_at FROM files WHERE firm_id = ? AND request_id = ? AND state = 'live' AND deleted_at IS NULL ORDER BY uploaded_at, rowid")
    .bind(req.firm_id, req.id)
    .all<{ item_id: string }>();
  const { results: notes } = await db
    .prepare(NEWEST)
    .bind(req.firm_id, req.id)
    .all();
  // only what the emails to this client already show
  const [sender] = (await sendersOf(c.env, link.region, [req.firm_id])).values();
  const meta = JSON.stringify({ link: hash });
  await db
    .prepare(
      `INSERT INTO audit (id, firm_id, at, actor_type, action, object_type, object_id, ip_hash, meta)
       SELECT ?, ?, ?, 'client', 'link.open', 'request', ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM audit WHERE firm_id = ? AND object_type = 'request' AND object_id = ? AND action = 'link.open' AND meta = ? AND at > ?)`,
    )
    .bind(randomId(), req.firm_id, now, req.id, await hmac(c.env.HASH_KEY, ipPrefix(ip ?? "unknown")), meta, req.firm_id, req.id, meta, now - HOUR)
    .run();
  return c.json({
    firm_name: req.firm_name,
    tz: req.tz ?? "America/Toronto",
    title: req.title,
    note: req.note,
    deadline: req.deadline,
    status: req.status,
    expires_at: req.expires_at,
    contact: canSend(sender, now) ? { name: sender.legal_name ?? sender.name, email: sender.owner_email, phone: sender.phone, address: sender.address } : null,
    notes,
    items: results.map((i) => ({
      ...i,
      required: i.required === 1,
      files: files.filter((f) => f.item_id === i.id).map(({ item_id: _item, ...f }) => f),
    })),
  });
});
