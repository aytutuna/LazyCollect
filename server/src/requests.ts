import { Hono, type Context } from "hono";
import { audit } from "./audit";
import { usable } from "./firm";
import { LINK_GRACE, sealToken } from "./links";
import { deliver, unsubUrl } from "./mail";
import { regionOf, type Region } from "./regions";
import { missingItems, senderName, sendersOf } from "./reminders";
import { syncStatus } from "./status";
import { nextReminder } from "./tz";
import type { AppEnv } from "./session";
import { builtinTemplates, parseItem, parseItems, type Item } from "./templates";
import { DAY, hmac, randomId, randomToken } from "./util";
import { invalid, maybe, notFound, readBody, setClause, text } from "./validate";

export const requests = new Hono<AppEnv>();

const COLS = "id, client_id, title, note, deadline, firm_name, status, sent_at, closed_at, created_at, reminders_on, next_reminder_at";
const ITEM_COLS = "id, position, label, help, required, status, reject_note, reviewed_at";
const MAX_ITEMS = 100;
const MAX_AHEAD = 2 * 365 * DAY;

type Req = { id: string; client_id: string; title: string; status: string; deadline: number; reminders_on: number };

const findRequest = (c: Context<AppEnv>) =>
  c.get("db")
    .prepare("SELECT id, client_id, title, status, deadline, reminders_on FROM requests WHERE firm_id = ? AND id = ? AND deleted_at IS NULL")
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
  const row = await db.prepare(`SELECT ${COLS} FROM requests WHERE firm_id = ? AND id = ?`).bind(firmId, id).first<{ reminders_on: number }>();
  const { results } = await db
    .prepare(`SELECT ${ITEM_COLS} FROM items WHERE firm_id = ? AND request_id = ? ORDER BY position`)
    .bind(firmId, id)
    .all<{ id: string; required: number }>();
  const { results: files } = await db
    .prepare("SELECT id, item_id, name, size, mime, uploaded_at FROM files WHERE firm_id = ? AND request_id = ? AND state = 'live' AND deleted_at IS NULL ORDER BY uploaded_at, rowid")
    .bind(firmId, id)
    .all<{ item_id: string }>();
  return {
    ...row,
    reminders_on: row!.reminders_on === 1,
    items: results.map((i) => ({
      ...i,
      required: i.required === 1,
      files: files.filter((f) => f.item_id === i.id).map(({ item_id: _item, ...f }) => f),
    })),
  };
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
  if ("reminders_on" in body) {
    if (typeof body.reminders_on !== "boolean") return invalid(c);
    fields.reminders_on = body.reminders_on ? 1 : 0;
  }
  if (!Object.keys(fields).length) return invalid(c);
  const req = await findRequest(c);
  if (!req) return notFound(c);
  if (req.status === "closed") return c.json({ error: "locked" }, 409);
  if (typeof fields.deadline === "number" && req.status !== "draft" && !usable(c.get("firm"), Date.now())) {
    return c.json({ error: "plan" }, 402);
  }
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const now = Date.now();
  const due = typeof fields.deadline === "number" ? fields.deadline : req.deadline;
  const on = "reminders_on" in fields ? fields.reminders_on === 1 : req.reminders_on === 1;
  // a draft has no cadence until its link goes out; a passed deadline has had its note already
  if (req.status !== "draft" && ("reminders_on" in fields || "deadline" in fields)) {
    fields.next_reminder_at = on && due > now ? nextReminder(now, due, c.get("firm").tz) : null;
  }
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

const editable = (req: Req) => req.status === "draft" || req.status === "open" || req.status === "complete";

// repeated in the write itself so a close that lands after the read still wins
const LIVE = "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('draft', 'open', 'complete') AND deleted_at IS NULL)";

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
    syncStatus(db, firmId, req.id),
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
    syncStatus(db, firmId, req.id),
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
  const firm = c.get("firm");
  const firmId = firm.id;
  const itemId = c.req.param("itemId");
  // rows of files the client removed still wait for the sweep; their objects go now so the item can leave
  const { results: gone } = await db
    .prepare("SELECT id, r2_key FROM files WHERE firm_id = ? AND item_id = ? AND deleted_at IS NOT NULL")
    .bind(firmId, itemId)
    .all<{ id: string; r2_key: string }>();
  if (gone.length) await regionOf(c.env, firm.region as Region).bucket.delete(gone.map((f) => f.r2_key));
  const bare = "status = 'empty' AND NOT EXISTS (SELECT 1 FROM files WHERE firm_id = items.firm_id AND item_id = items.id AND deleted_at IS NULL)";
  const binds = [firmId, req.id, itemId, firmId, req.id];
  // the audit row goes first: its condition reads the item the delete removes
  const [, , res] = await db.batch([
    audit(c, "item.delete", "item", itemId, { request: req.id }, {
      sql: `EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND ${bare}) AND ${LIVE}`,
      binds,
    }),
    db
      .prepare("DELETE FROM files WHERE firm_id = ? AND item_id = ? AND deleted_at IS NOT NULL AND id IN (SELECT value FROM json_each(?))")
      .bind(firmId, itemId, JSON.stringify(gone.map((f) => f.id))),
    db.prepare(`DELETE FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND ${bare} AND ${LIVE}`).bind(...binds),
    syncStatus(db, firmId, req.id),
  ]);
  if (res.meta.changes) return c.json({ ok: true });
  const left = await db.prepare("SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ?").bind(firmId, req.id, itemId).first();
  return left && (await findRequest(c)) ? c.json({ error: "has_upload" }, 409) : refused(c);
});

requests.post("/requests/:id/items/:itemId/review", async (c) => {
  const body = await readBody(c);
  if (!body || (body.decision !== "approve" && body.decision !== "reject")) return invalid(c);
  const seen = Array.isArray(body.files) && body.files.every((f) => typeof f === "string") ? [...new Set(body.files as string[])] : null;
  if (!seen) return invalid(c);
  const approve = body.decision === "approve";
  const note = approve ? null : text(body.note, 500);
  if (!approve && !note) return invalid(c);
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const itemId = c.req.param("itemId");
  const status = approve ? "approved" : "rejected";
  const ready = `EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND status IN ('submitted', 'approved'))
    AND EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL)`;
  // the files the reviewer was looking at must still be exactly the item's live files
  const live = "firm_id = ? AND item_id = ? AND state = 'live' AND deleted_at IS NULL";
  const same = `(SELECT COUNT(*) FROM files WHERE ${live}) = ?
    AND NOT EXISTS (SELECT 1 FROM files WHERE ${live} AND id NOT IN (SELECT value FROM json_each(?)))`;
  const binds = [firmId, req.id, itemId, firmId, req.id];
  const sameBinds = [firmId, itemId, seen.length, firmId, itemId, JSON.stringify(seen)];
  // the audit row goes first: its condition reads the status the update changes
  const at = Date.now();
  const [, res] = await db.batch([
    audit(c, "item.review", "item", itemId, { request: req.id, decision: body.decision }, { sql: `${ready} AND ${same}`, binds: [...binds, ...sameBinds] }),
    db
      .prepare(`UPDATE items SET status = ?, reject_note = ?, reviewed_by = ?, reviewed_at = ? WHERE firm_id = ? AND request_id = ? AND id = ? AND ${ready} AND ${same}`)
      .bind(status, note, c.get("session")!.userId, at, firmId, req.id, itemId, ...binds, ...sameBinds),
    syncStatus(db, firmId, req.id),
    // the client hears about rejections from the reminder pass, once they stop coming in
    ...(approve
      ? []
      : [
          db
            .prepare(
              `UPDATE requests SET reject_mark_at = ? WHERE firm_id = ? AND id = ?
               AND EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND status = 'rejected' AND reviewed_at = ?)`,
            )
            .bind(at, firmId, req.id, firmId, req.id, itemId, at),
        ]),
  ]);
  if (!res.meta.changes) {
    const item = await db
      .prepare("SELECT status FROM items WHERE firm_id = ? AND request_id = ? AND id = ?")
      .bind(firmId, req.id, itemId)
      .first<{ status: string }>();
    if (!item) return notFound(c);
    const now = await findRequest(c);
    const reviewable = (item.status === "submitted" || item.status === "approved") && (now?.status === "open" || now?.status === "complete");
    return c.json({ error: reviewable ? "stale" : "locked" }, 409);
  }
  const row = await db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`).bind(itemId).first<{ required: number }>();
  return c.json({ ...row, required: row!.required === 1 });
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

requests.delete("/requests/:id", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const now = Date.now();
  await db.batch([
    audit(c, "request.delete", "request", req.id, undefined, {
      sql: "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND deleted_at IS NULL)",
      binds: [firmId, req.id],
    }),
    db.prepare("UPDATE requests SET deleted_at = ? WHERE firm_id = ? AND id = ? AND deleted_at IS NULL").bind(now, firmId, req.id),
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
  const body = await readBody(c);
  const sendEmail = body?.send_email === true;
  let invitee: { name: string; email: string } | null = null;
  if (sendEmail) {
    if (!firm.address) return c.json({ error: "address_needed" }, 400);
    const client = await db
      .prepare("SELECT name, email, email_ok_at, email_stop_at FROM clients WHERE firm_id = ? AND id = ? AND deleted_at IS NULL")
      .bind(firm.id, req.client_id)
      .first<{ name: string; email: string | null; email_ok_at: number | null; email_stop_at: number | null }>();
    if (!client?.email || !client.email_ok_at) return c.json({ error: "client_email_needed" }, 400);
    if (client.email_stop_at) return c.json({ error: "client_unsubscribed" }, 400);
    invitee = { name: client.name, email: client.email };
  }

  const userId = c.get("session")!.userId;
  const token = `${firm.region}_${randomToken()}`;
  const hash = await hmac(c.env.HASH_KEY, token.slice(firm.region.length + 1));
  const results = await db.batch([
    db.prepare(`UPDATE links SET revoked_at = ? WHERE firm_id = ? AND request_id = ? AND revoked_at IS NULL AND ${LIVE}`).bind(now, firm.id, req.id, firm.id, req.id),
    db
      .prepare(`INSERT INTO links (token_hash, firm_id, request_id, expires_at, created_by, created_at, token_enc) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${LIVE}`)
      .bind(hash, firm.id, req.id, req.deadline + LINK_GRACE, userId, now, await sealToken(c.env, token), firm.id, req.id),
    db
      .prepare(
        `INSERT INTO audit (id, firm_id, at, actor_type, actor_id, action, object_type, object_id)
         SELECT ?, ?, ?, 'user', ?, 'link.create', 'request', ? WHERE ${LIVE}`,
      )
      .bind(randomId(), firm.id, now, userId, req.id, firm.id, req.id),
    db
      .prepare(
        `UPDATE requests SET status = CASE WHEN status = 'draft' THEN 'open' ELSE status END, sent_at = ?, firm_name = ?,
           next_reminder_at = CASE WHEN reminders_on = 1 THEN ? ELSE NULL END
         WHERE firm_id = ? AND id = ? AND status IN ('draft', 'open', 'complete') AND deleted_at IS NULL`,
      )
      .bind(now, firm.name, nextReminder(now, req.deadline, firm.tz), firm.id, req.id),
    syncStatus(db, firm.id, req.id),
  ]);
  if (!results[1].meta.changes) return refused(c);
  const url = `${c.env.APP_URL}/c/${token}`;
  if (!invitee) return c.json({ url });

  try {
    const [sender] = (await sendersOf(c.env, firm.region as Region, [firm.id])).values();
    const { outcome } = await deliver(
      c.env,
      { db, firmId: firm.id, requestId: req.id, clientId: req.client_id, kind: "invite", seq: null },
      {
        kind: "invite",
        sender: senderName(sender),
        address: firm.address!,
        phone: firm.phone,
        replyTo: sender.owner_email!,
        clientName: invitee.name,
        clientEmail: invitee.email,
        title: req.title,
        deadline: req.deadline,
        tz: firm.tz,
        items: await missingItems(db, firm.id, req.id, false),
        url,
        unsubUrl: await unsubUrl(c.env, firm.region as Region, req.client_id, firm.id),
      },
      now,
    );
    if (outcome === "sent") return c.json({ url, emailed: true });
  } catch (e) {
    console.error(e instanceof Error ? e.message : "error");
  }
  return c.json({ url, email_failed: true });
});

requests.get("/requests/:id/messages", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const { results } = await c.get("db")
    .prepare("SELECT id, kind, seq, status, sent_at FROM messages WHERE firm_id = ? AND request_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT 100")
    .bind(c.get("firm").id, req.id)
    .all();
  return c.json(results);
});
