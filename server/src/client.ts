import { Hono, type Context } from "hono";
import { rateLimited } from "./auth";
import { isRegion, regionOf, type Region } from "./regions";
import { NEWEST } from "./notes";
import { presentItem, visible } from "./questions";
import { canSend, sendersOf } from "./reminders";
import { loadClientSession, type AppEnv } from "./session";
import { HOUR, hmac, ipPrefix, randomId } from "./util";
import { notFound } from "./validate";

export const client = new Hono<AppEnv>();

const TOKEN_RE = /^([a-z]+)_([\w-]{43})$/;

export type LiveLink = {
  region: Region;
  db: D1Database;
  hash: string;
  req: { id: string; firm_id: string; firm_name: string; tz: string | null; title: string; note: string | null; deadline: number; status: string; expires_at: number; first_opened_at: number | null };
};

async function linkByHash(env: Env, region: Region, hash: string): Promise<LiveLink | null> {
  const db = regionOf(env, region).db;
  const req = await db
    .prepare(
      `SELECT r.id, r.firm_id, r.firm_name, r.tz, r.title, r.note, r.deadline, r.status, r.first_opened_at, l.expires_at
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

export async function findLink(env: Env, token: string): Promise<LiveLink | null> {
  const match = TOKEN_RE.exec(token);
  if (!match || !isRegion(match[1])) return null;
  return linkByHash(env, match[1], await hmac(env.HASH_KEY, match[2]));
}

// The link of the request's :token: the token itself, or "me" for an app that holds a client session. The session
// keeps only the link's hash, so a revoked or expired link ends it too.
export async function linkOf(c: Context<AppEnv>): Promise<LiveLink | null> {
  const token = c.req.param("token") ?? "";
  if (token !== "me") return findLink(c.env, token);
  const session = await loadClientSession(c);
  return session && isRegion(session.region) ? linkByHash(c.env, session.region, session.linkHash) : null;
}

// what the client sees: the items that apply to them, with their files and the answers they gave
export async function clientItems(db: D1Database, firmId: string, requestId: string) {
  const { results } = await db
    .prepare(
      `SELECT id, label, help, required, status, reject_note, reject_reasons, unavailable_note, kind, example, options_json, answer, person_pos, expiry_rule, valid_months, expires_on, issued_on FROM items i
       WHERE firm_id = ? AND request_id = ? AND ${visible("i")} ORDER BY position`,
    )
    .bind(firmId, requestId)
    .all<any>();
  const { results: files } = await db
    .prepare("SELECT id, item_id, name, size, uploaded_at, sent_back_at FROM files WHERE firm_id = ? AND request_id = ? AND state = 'live' AND deleted_at IS NULL ORDER BY uploaded_at, rowid")
    .bind(firmId, requestId)
    .all<{ item_id: string }>();
  return results.map((i) => ({ ...presentItem(i), files: files.filter((f) => f.item_id === i.id).map(({ item_id: _item, ...f }) => f) }));
}

client.get("/c/:token", async (c) => {
  const ip = c.req.header("CF-Connecting-IP");
  if (await rateLimited(c.env, c.env.CLIENT, ip)) return c.json({ error: "rate_limited" }, 429);
  const link = await linkOf(c);
  if (!link) return notFound(c);
  const { db, hash, req } = link;
  const now = Date.now();

  const items = await clientItems(db, req.firm_id, req.id);
  const { results: notes } = await db
    .prepare(NEWEST)
    .bind(req.firm_id, req.id)
    .all();
  const { results: people } = await db
    .prepare("SELECT position, role, name FROM people WHERE firm_id = ? AND request_id = ? ORDER BY position")
    .bind(req.firm_id, req.id)
    .all();
  // only what the emails to this client already show
  const [sender] = (await sendersOf(c.env, link.region, [req.firm_id])).values();
  // the first look by the client counts; the account's own staff opening the link while signed in do not
  if (req.first_opened_at === null && c.get("session")?.firmId !== req.firm_id) {
    await db.prepare("UPDATE requests SET first_opened_at = ? WHERE firm_id = ? AND id = ? AND first_opened_at IS NULL").bind(now, req.firm_id, req.id).run();
  }
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
    people,
    items,
  });
});
