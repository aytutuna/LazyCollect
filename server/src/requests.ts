import { Hono, type Context } from "hono";
import { audit } from "./audit";
import { usable } from "./firm";
import type { AppEnv } from "./session";
import { builtinTemplates, parseItem, parseItems, type Item } from "./templates";
import { DAY, hmac, randomId, randomToken } from "./util";
import { invalid, maybe, notFound, readBody, setClause, text } from "./validate";

export const requests = new Hono<AppEnv>();

const COLS = "id, client_id, title, note, deadline, firm_name, status, sent_at, closed_at, created_at";
const ITEM_COLS = "id, position, label, help, required, status, reject_note, reviewed_at";
const LINK_GRACE = 30 * DAY;
const MAX_ITEMS = 100;
const MAX_AHEAD = 2 * 365 * DAY;

type Req = { id: string; status: string; deadline: number };

const findRequest = (c: Context<AppEnv>) =>
  c.get("db")
    .prepare("SELECT id, status, deadline FROM requests WHERE firm_id = ? AND id = ? AND deleted_at IS NULL")
    .bind(c.get("firm").id, c.req.param("id"))
    .first<Req>();

function deadline(v: unknown): number | undefined {
  const now = Date.now();
  return Number.isInteger(v) && (v as number) > now && (v as number) <= now + MAX_AHEAD ? (v as number) : undefined;
}

requests.post("/requests", async (c) => {
  const body = await readBody(c);
  if (!body) return invalid(c);
  const title = text(body.title, 200);
  const note = maybe(body.note, 2000);
  const due = deadline(body.deadline);
  if (!title || note === undefined || due === undefined || typeof body.client_id !== "string") return invalid(c);
  if (body.template_id !== undefined && body.items !== undefined) return invalid(c);
  const db = c.get("db");
  const firmId = c.get("firm").id;

  const client = await db
    .prepare("SELECT id FROM clients WHERE firm_id = ? AND id = ? AND deleted_at IS NULL")
    .bind(firmId, body.client_id)
    .first();
  if (!client) return notFound(c);

  let items: Item[] = [];
  if (body.template_id !== undefined) {
    if (typeof body.template_id !== "string") return invalid(c);
    const built = builtinTemplates.find((t) => t.id === body.template_id);
    if (built) {
      items = built.items;
    } else {
      const row = await db
        .prepare("SELECT items_json FROM templates WHERE firm_id = ? AND id = ?")
        .bind(firmId, body.template_id)
        .first<{ items_json: string }>();
      if (!row) return notFound(c);
      items = JSON.parse(row.items_json);
    }
  } else if (body.items !== undefined) {
    const parsed = parseItems(body.items);
    if (!parsed) return invalid(c);
    items = parsed;
  }

  const id = randomId();
  const now = Date.now();
  await db.batch([
    db
      .prepare("INSERT INTO requests (id, firm_id, client_id, title, note, deadline, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, firmId, body.client_id, title, note, due, c.get("session")!.userId, now),
    db
      .prepare(
        `INSERT INTO items (id, firm_id, request_id, position, label, help, required)
         SELECT lower(hex(randomblob(16))), ?, ?, key, json_extract(value, '$.label'), json_extract(value, '$.help'), json_extract(value, '$.required')
         FROM json_each(?)`,
      )
      .bind(firmId, id, JSON.stringify(items)),
    audit(c, "request.create", "request", id),
  ]);
  return c.json(await loadRequest(c, id), 201);
});

async function loadRequest(c: Context<AppEnv>, id: string) {
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const row = await db.prepare(`SELECT ${COLS} FROM requests WHERE firm_id = ? AND id = ?`).bind(firmId, id).first();
  const { results } = await db
    .prepare(`SELECT ${ITEM_COLS} FROM items WHERE firm_id = ? AND request_id = ? ORDER BY position`)
    .bind(firmId, id)
    .all<{ required: number }>();
  return { ...row, items: results.map((i) => ({ ...i, required: i.required === 1 })) };
}

requests.get("/requests", async (c) => {
  const { results } = await c.get("db")
    .prepare(
      `SELECT r.id, r.client_id, cl.name AS client_name, r.title, r.deadline, r.status, r.sent_at, r.created_at,
         COALESCE(SUM(i.status = 'empty'), 0) AS empty,
         COALESCE(SUM(i.status = 'submitted'), 0) AS submitted,
         COALESCE(SUM(i.status = 'approved'), 0) AS approved,
         COALESCE(SUM(i.status = 'rejected'), 0) AS rejected
       FROM requests r
       JOIN clients cl ON cl.firm_id = r.firm_id AND cl.id = r.client_id AND cl.deleted_at IS NULL
       LEFT JOIN items i ON i.firm_id = r.firm_id AND i.request_id = r.id
       WHERE r.firm_id = ? AND r.deleted_at IS NULL
       GROUP BY r.id
       ORDER BY r.created_at DESC, r.rowid DESC`,
    )
    .bind(c.get("firm").id)
    .all();
  return c.json(results);
});

requests.get("/requests/:id", async (c) => {
  const req = await findRequest(c);
  return req ? c.json(await loadRequest(c, req.id)) : notFound(c);
});

requests.patch("/requests/:id", async (c) => {
  const body = await readBody(c);
  if (!body) return invalid(c);
  const fields: Record<string, string | number | null> = {};
  if ("title" in body) {
    const title = text(body.title, 200);
    if (!title) return invalid(c);
    fields.title = title;
  }
  if ("note" in body) {
    const note = maybe(body.note, 2000);
    if (note === undefined) return invalid(c);
    fields.note = note;
  }
  if ("deadline" in body) {
    const due = deadline(body.deadline);
    if (due === undefined) return invalid(c);
    fields.deadline = due;
  }
  if (!Object.keys(fields).length) return invalid(c);
  const req = await findRequest(c);
  if (!req) return notFound(c);
  if (req.status === "closed") return c.json({ error: "locked" }, 409);
  if (typeof fields.deadline === "number" && req.status === "open" && !usable(c.get("firm"), Date.now())) {
    return c.json({ error: "plan" }, 402);
  }
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const set = setClause(fields);
  const stmts = [db.prepare(`UPDATE requests SET ${set.sql} WHERE firm_id = ? AND id = ?`).bind(...set.values, firmId, req.id)];
  // a later deadline would otherwise leave the live link expiring early
  if (typeof fields.deadline === "number") {
    stmts.push(
      db.prepare("UPDATE links SET expires_at = ? WHERE firm_id = ? AND request_id = ? AND revoked_at IS NULL").bind(fields.deadline + LINK_GRACE, firmId, req.id),
    );
  }
  stmts.push(audit(c, "request.update", "request", req.id, { fields: Object.keys(fields) }));
  await db.batch(stmts);
  return c.json(await loadRequest(c, req.id));
});

const editable = (req: Req) => req.status === "draft" || req.status === "open";

// repeated in the write itself so a close that lands after the read still wins
const LIVE = "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('draft', 'open') AND deleted_at IS NULL)";

async function refused(c: Context<AppEnv>) {
  const req = await findRequest(c);
  return req && !editable(req) ? c.json({ error: "locked" }, 409) : notFound(c);
}

requests.post("/requests/:id/items", async (c) => {
  const body = await readBody(c);
  const item = body ? parseItem(body) : undefined;
  if (!item) return invalid(c);
  const req = await findRequest(c);
  if (!req) return notFound(c);
  if (!editable(req)) return c.json({ error: "locked" }, 409);
  const id = randomId();
  const firmId = c.get("firm").id;
  const db = c.get("db");
  const [res] = await db.batch([
    db
      .prepare(
        `INSERT INTO items (id, firm_id, request_id, position, label, help, required)
         SELECT ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM items WHERE firm_id = ? AND request_id = ?), ?, ?, ?
         WHERE ${LIVE} AND (SELECT COUNT(*) FROM items WHERE firm_id = ? AND request_id = ?) < ${MAX_ITEMS}`,
      )
      .bind(id, firmId, req.id, firmId, req.id, item.label, item.help ?? null, item.required ? 1 : 0, firmId, req.id, firmId, req.id),
    audit(c, "item.add", "item", id, { request: req.id }, { sql: "EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND id = ?)", binds: [firmId, id] }),
  ]);
  if (!res.meta.changes) {
    const now = await findRequest(c);
    return now && editable(now) ? c.json({ error: "too_many_items" }, 409) : refused(c);
  }
  const row = await db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`).bind(id).first<{ required: number }>();
  return c.json({ ...row, required: row!.required === 1 }, 201);
});

requests.patch("/requests/:id/items/:itemId", async (c) => {
  const body = await readBody(c);
  if (!body) return invalid(c);
  const fields: Record<string, string | number | null> = {};
  if ("label" in body) {
    const label = text(body.label, 200);
    if (!label) return invalid(c);
    fields.label = label;
  }
  if ("help" in body) {
    const help = maybe(body.help, 500);
    if (help === undefined) return invalid(c);
    fields.help = help;
  }
  if ("required" in body) {
    if (typeof body.required !== "boolean") return invalid(c);
    fields.required = body.required ? 1 : 0;
  }
  if (!Object.keys(fields).length) return invalid(c);
  const req = await findRequest(c);
  if (!req) return notFound(c);
  if (!editable(req)) return c.json({ error: "locked" }, 409);
  const set = setClause(fields);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const itemId = c.req.param("itemId");
  const [res] = await db.batch([
    db
      .prepare(`UPDATE items SET ${set.sql} WHERE firm_id = ? AND request_id = ? AND id = ? AND ${LIVE}`)
      .bind(...set.values, firmId, req.id, itemId, firmId, req.id),
    audit(c, "item.edit", "item", itemId, { request: req.id, fields: Object.keys(fields) }, {
      sql: `EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ?) AND ${LIVE}`,
      binds: [firmId, req.id, itemId, firmId, req.id],
    }),
  ]);
  if (!res.meta.changes) return refused(c);
  const row = await db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`).bind(c.req.param("itemId")).first<{ required: number }>();
  return c.json({ ...row, required: row!.required === 1 });
});

requests.delete("/requests/:id/items/:itemId", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  if (!editable(req)) return c.json({ error: "locked" }, 409);
  const db = c.get("db");
  const item = await db
    .prepare("SELECT status FROM items WHERE firm_id = ? AND request_id = ? AND id = ?")
    .bind(c.get("firm").id, req.id, c.req.param("itemId"))
    .first<{ status: string }>();
  if (!item) return notFound(c);
  if (item.status !== "empty") return c.json({ error: "has_upload" }, 409);
  const firmId = c.get("firm").id;
  const itemId = c.req.param("itemId");
  // the audit row goes first: its condition reads the item the delete removes
  const [, res] = await db.batch([
    audit(c, "item.delete", "item", itemId, { request: req.id }, {
      sql: `EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND status = 'empty') AND ${LIVE}`,
      binds: [firmId, req.id, itemId, firmId, req.id],
    }),
    db
      .prepare(`DELETE FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND status = 'empty' AND ${LIVE}`)
      .bind(firmId, req.id, itemId, firmId, req.id),
  ]);
  return res.meta.changes ? c.json({ ok: true }) : refused(c);
});

requests.post("/requests/:id/close", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const now = Date.now();
  await db.batch([
    audit(c, "request.close", "request", req.id, undefined, {
      sql: "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status != 'closed')",
      binds: [firmId, req.id],
    }),
    db.prepare("UPDATE requests SET status = 'closed', closed_at = ? WHERE firm_id = ? AND id = ? AND status != 'closed'").bind(now, firmId, req.id),
    db.prepare("UPDATE links SET revoked_at = ? WHERE firm_id = ? AND request_id = ? AND revoked_at IS NULL").bind(now, firmId, req.id),
  ]);
  return c.json({ ok: true });
});

requests.post("/requests/:id/link", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const firm = c.get("firm");
  if (!firm.name) return c.json({ error: "firm_profile" }, 400);
  const now = Date.now();
  if (!usable(firm, now)) return c.json({ error: "plan" }, 402);
  if (!editable(req)) return c.json({ error: "locked" }, 409);
  if (req.deadline <= now) return c.json({ error: "deadline_passed" }, 409);

  const db = c.get("db");
  const userId = c.get("session")!.userId;
  const token = `${firm.region}_${randomToken()}`;
  const hash = await hmac(c.env.HASH_KEY, token.slice(firm.region.length + 1));
  const results = await db.batch([
    db.prepare(`UPDATE links SET revoked_at = ? WHERE firm_id = ? AND request_id = ? AND revoked_at IS NULL AND ${LIVE}`).bind(now, firm.id, req.id, firm.id, req.id),
    db
      .prepare(`INSERT INTO links (token_hash, firm_id, request_id, expires_at, created_by, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${LIVE}`)
      .bind(hash, firm.id, req.id, req.deadline + LINK_GRACE, userId, now, firm.id, req.id),
    db
      .prepare(
        `INSERT INTO audit (id, firm_id, at, actor_type, actor_id, action, object_type, object_id)
         SELECT ?, ?, ?, 'user', ?, 'link.create', 'request', ? WHERE ${LIVE}`,
      )
      .bind(randomId(), firm.id, now, userId, req.id, firm.id, req.id),
    db
      .prepare("UPDATE requests SET status = 'open', sent_at = ?, firm_name = ? WHERE firm_id = ? AND id = ? AND status IN ('draft', 'open') AND deleted_at IS NULL")
      .bind(now, firm.name, firm.id, req.id),
  ]);
  if (!results[1].meta.changes) return refused(c);
  return c.json({ url: `${c.env.APP_URL}/c/${token}` });
});
