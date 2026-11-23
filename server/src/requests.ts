import { Hono, type Context } from "hono";
import { audit } from "./audit";
import { itemsFromTemplate } from "./copy";
import { ownsExamples, parseExample } from "./examples";
import { usable } from "./firm";
import { LINK_GRACE, sealToken } from "./links";
import { MANUAL_SEQ, addressStopped, deliver, hasRoom, unsubUrl } from "./mail";
import { ITEM_COLS, conditionOk, isQuestion, presentItem } from "./questions";
import { regionOf, type Region } from "./regions";
import { parseReasons } from "./reasons";
import { listRequests } from "./search";
import { missingItems, senderName, sendersOf } from "./reminders";
import { endNow, syncStatus } from "./status";
import { nextReminder } from "./tz";
import type { AppEnv } from "./session";
import { builtinTemplates, parseItem, parseItems, type Item } from "./templates";
import { DAY, hmac, randomId, randomToken } from "./util";
import { invalid, maybe, notFound, readBody, setClause, text } from "./validate";

export const requests = new Hono<AppEnv>();

const COLS = "id, client_id, title, note, deadline, firm_name, status, sent_at, closed_at, created_at, first_opened_at, reminders_on, next_reminder_at, ended_at, keep_until, hold_at";
const MAX_ITEMS = 100;
const MAX_PER_DAY = 300;
// requests made by a batch have a cap of their own
export const SINGLE_TODAY = `(SELECT COUNT(*) FROM requests WHERE firm_id = ? AND created_at > ? AND id NOT IN (SELECT request_id FROM batch_items WHERE firm_id = ?)) < ${MAX_PER_DAY}`;
const MAX_AHEAD = 2 * 365 * DAY;

type Req = { id: string; client_id: string; title: string; status: string; deadline: number; reminders_on: number; hold_at: number | null };

export const findRequest = (c: Context<AppEnv>) =>
  c.get("db")
    .prepare("SELECT id, client_id, title, status, deadline, reminders_on, hold_at FROM requests WHERE firm_id = ? AND id = ? AND deleted_at IS NULL")
    .bind(c.get("firm").id, c.req.param("id"))
    .first<Req>();

export function deadline(v: unknown): number | undefined {
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
    if (!parsed || !(await ownsExamples(db, firmId, parsed.map((i) => i.example)))) return invalid(c);
    items = parsed;
  }

  const id = randomId();
  const now = Date.now();
  const made = { sql: "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ?)", binds: [firmId, id] };
  const [res] = await db.batch([
    db
      .prepare(
        `INSERT INTO requests (id, firm_id, client_id, title, note, deadline, created_by, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${SINGLE_TODAY}`,
      )
      .bind(id, firmId, body.client_id, title, note, due, c.get("session")!.userId, now, firmId, now - DAY, firmId),
    itemsFromTemplate(db, firmId, [id], items),
    audit(c, "request.create", "request", id, undefined, made),
  ]);
  if (!res.meta.changes) return c.json({ error: "too_many_requests" }, 429);
  return c.json(await loadRequest(c, id), 201);
});

export async function loadRequest(c: Context<AppEnv>, id: string) {
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const row = await db.prepare(`SELECT ${COLS} FROM requests WHERE firm_id = ? AND id = ?`).bind(firmId, id).first<{ reminders_on: number }>();
  const { results } = await db
    .prepare(`SELECT ${ITEM_COLS} FROM items WHERE firm_id = ? AND request_id = ? ORDER BY position`)
    .bind(firmId, id)
    .all<any>();
  const { results: files } = await db
    .prepare("SELECT id, item_id, name, size, mime, uploaded_at, sent_back_at FROM files WHERE firm_id = ? AND request_id = ? AND state = 'live' AND deleted_at IS NULL ORDER BY uploaded_at, rowid")
    .bind(firmId, id)
    .all<{ item_id: string }>();
  return {
    ...row,
    reminders_on: row!.reminders_on === 1,
    items: results.map((i) => ({
      ...presentItem(i),
      files: files.filter((f) => f.item_id === i.id).map(({ item_id: _item, ...f }) => f),
    })),
  };
}

requests.get("/requests", listRequests);

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
    fields.next_reminder_at = on && due > now ? nextReminder(now, due, c.get("firm").tz, true) : null;
  }
  // an open request's clock only runs once its link has expired, so a later deadline stops it
  if (typeof fields.deadline === "number" && req.status === "open") {
    fields.ended_at = null;
    fields.keep_until = null;
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
  if (!(await ownsExamples(db, firmId, [item.example]))) return invalid(c);
  if (item.show_if) {
    // here the condition names a position that is already in the request
    const p = await db
      .prepare("SELECT kind, options_json, show_if_pos FROM items WHERE firm_id = ? AND request_id = ? AND position = ?")
      .bind(firmId, req.id, item.show_if.item)
      .first<{ kind: string; options_json: string | null; show_if_pos: number | null }>();
    if (!conditionOk(item.show_if, p ? { kind: p.kind, options: p.options_json ? JSON.parse(p.options_json) : null, conditional: p.show_if_pos !== null } : undefined)) return invalid(c);
  }
  const [res] = await db.batch([
    db
      .prepare(
        `INSERT INTO items (id, firm_id, request_id, position, label, help, required, kind, options_json, show_if_pos, show_if_value, example)
         SELECT ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM items WHERE firm_id = ? AND request_id = ?), ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${LIVE} AND (SELECT COUNT(*) FROM items WHERE firm_id = ? AND request_id = ?) < ${MAX_ITEMS}`,
      )
      .bind(
        id, firmId, req.id, firmId, req.id, item.label, item.help ?? null, item.required ? 1 : 0,
        item.kind ?? "file", item.options ? JSON.stringify(item.options) : null, item.show_if?.item ?? null, item.show_if?.value ?? null, item.example ?? null,
        firmId, req.id, firmId, req.id,
      ),
    audit(c, "item.add", "item", id, { request: req.id }, { sql: "EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND id = ?)", binds: [firmId, id] }),
    syncStatus(db, firmId, req.id),
  ]);
  if (!res.meta.changes) {
    const now = await findRequest(c);
    return now && editable(now) ? c.json({ error: "too_many_items" }, 409) : refused(c);
  }
  const row = await db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`).bind(id).first<any>();
  return c.json(presentItem(row), 201);
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
  if ("example" in body) {
    const example = parseExample(body.example);
    if (example === undefined) return invalid(c);
    fields.example = example;
  }
  if (!Object.keys(fields).length) return invalid(c);
  const req = await findRequest(c);
  if (!req) return notFound(c);
  if (!editable(req)) return c.json({ error: "locked" }, 409);
  const set = setClause(fields);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  if (!(await ownsExamples(db, firmId, [fields.example as string | null]))) return invalid(c);
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
  const row = await db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`).bind(c.req.param("itemId")).first<any>();
  return c.json(presentItem(row));
});

requests.delete("/requests/:id/items/:itemId", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  if (!editable(req)) return c.json({ error: "locked" }, 409);
  if (req.hold_at) return c.json({ error: "legal_hold" }, 409);
  const db = c.get("db");
  const item = await db
    .prepare("SELECT status FROM items WHERE firm_id = ? AND request_id = ? AND id = ?")
    .bind(c.get("firm").id, req.id, c.req.param("itemId"))
    .first<{ status: string }>();
  if (!item) return notFound(c);
  if (item.status !== "empty") return c.json({ error: "has_upload" }, 409);
  const dependent = await db
    .prepare("SELECT 1 FROM items d JOIN items i ON i.firm_id = d.firm_id AND i.request_id = d.request_id AND i.position = d.show_if_pos WHERE d.firm_id = ? AND d.request_id = ? AND i.id = ?")
    .bind(c.get("firm").id, req.id, c.req.param("itemId"))
    .first();
  if (dependent) return c.json({ error: "has_dependents" }, 409);
  const firm = c.get("firm");
  const firmId = firm.id;
  const itemId = c.req.param("itemId");
  const bare = "status = 'empty' AND NOT EXISTS (SELECT 1 FROM files WHERE firm_id = items.firm_id AND item_id = items.id AND deleted_at IS NULL)";
  const free = "NOT EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND hold_at IS NOT NULL)";
  const binds = [firmId, req.id, itemId, firmId, req.id, firmId, req.id];
  // rows of files the client removed still wait for the sweep; they go here, and only then their objects, so the item can leave
  // the audit row goes first: its condition reads the item the delete removes
  const [, gone, res] = await db.batch([
    audit(c, "item.delete", "item", itemId, { request: req.id }, {
      sql: `EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND ${bare}) AND ${LIVE} AND ${free}`,
      binds,
    }),
    db
      .prepare(`DELETE FROM files WHERE firm_id = ? AND item_id = ? AND deleted_at IS NOT NULL AND ${free} RETURNING r2_key`)
      .bind(firmId, itemId, firmId, req.id),
    db.prepare(`DELETE FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND ${bare} AND ${LIVE} AND ${free}`).bind(...binds),
    syncStatus(db, firmId, req.id),
  ]);
  const keys = (gone.results as { r2_key: string }[]).map((f) => f.r2_key);
  if (keys.length) await regionOf(c.env, firm.region as Region).bucket.delete(keys);
  if (res.meta.changes) return c.json({ ok: true });
  const left = await db.prepare("SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ?").bind(firmId, req.id, itemId).first();
  return left && (await findRequest(c)) ? c.json({ error: "has_upload" }, 409) : refused(c);
});

requests.post("/requests/:id/items/:itemId/review", async (c) => {
  const body = await readBody(c);
  if (!body || (body.decision !== "approve" && body.decision !== "reject")) return invalid(c);
  const answered = body.answered_at === undefined || body.answered_at === null ? null : Number.isInteger(body.answered_at) ? (body.answered_at as number) : undefined;
  const seen = answered !== undefined && Array.isArray(body.files) && body.files.every((f) => typeof f === "string") ? [...new Set(body.files as string[])] : null;
  if (!seen) return invalid(c);
  const approve = body.decision === "approve";
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const itemId = c.req.param("itemId");
  const kind = (await db.prepare("SELECT kind FROM items WHERE firm_id = ? AND request_id = ? AND id = ?").bind(firmId, req.id, itemId).first<{ kind: string }>())?.kind;
  if (!kind) return notFound(c);
  // a document needs a reason; a question can go back with just a note, and "other" is explained by it
  const reasons = approve ? [] : parseReasons(body.reasons, kind);
  const note = approve ? null : maybe(body.note, 500);
  if (!reasons || note === undefined) return invalid(c);
  if (!approve && ((!reasons.length && (!isQuestion(kind) || !note)) || (reasons.includes("other") && !note))) return invalid(c);
  const status = approve ? "approved" : "rejected";
  const ready = `EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND status IN ('submitted', 'approved'))
    AND EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL)`;
  // the files (or the answer) the reviewer was looking at must still be exactly what the item holds
  const live = "firm_id = ? AND item_id = ? AND state = 'live' AND deleted_at IS NULL";
  const same = `(SELECT COUNT(*) FROM files WHERE ${live}) = ?
    AND NOT EXISTS (SELECT 1 FROM files WHERE ${live} AND id NOT IN (SELECT value FROM json_each(?)))
    AND EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND answer_at IS ?)`;
  const binds = [firmId, req.id, itemId, firmId, req.id];
  const sameBinds = [firmId, itemId, seen.length, firmId, itemId, JSON.stringify(seen), firmId, req.id, itemId, answered];
  // the audit row goes first: its condition reads the status the update changes
  const at = Date.now();
  const [, res] = await db.batch([
    audit(c, "item.review", "item", itemId, { request: req.id, decision: body.decision, ...(reasons.length ? { reasons } : {}) }, { sql: `${ready} AND ${same}`, binds: [...binds, ...sameBinds] }),
    db
      .prepare(`UPDATE items SET status = ?, reject_note = ?, reject_reasons = ?, reviewed_by = ?, reviewed_at = ? WHERE firm_id = ? AND request_id = ? AND id = ? AND ${ready} AND ${same}`)
      .bind(status, note, reasons.length ? JSON.stringify(reasons) : null, c.get("session")!.userId, at, firmId, req.id, itemId, ...binds, ...sameBinds),
    syncStatus(db, firmId, req.id),
    // the client hears about rejections from the reminder pass, once they stop coming in
    ...(approve
      ? []
      : [
          // the files the reviewer saw are the ones sent back; a newer upload is not
          db
            .prepare(
              `UPDATE files SET sent_back_at = COALESCE(sent_back_at, ?) WHERE firm_id = ? AND item_id = ? AND state = 'live' AND deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND status = 'rejected' AND reviewed_at = ?)`,
            )
            .bind(at, firmId, itemId, firmId, req.id, itemId, at),
          db
            .prepare(
              `UPDATE requests SET reject_mark_at = ? WHERE firm_id = ? AND id = ?
               AND EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND status = 'rejected' AND reviewed_at = ?)`,
            )
            .bind(at, firmId, req.id, firmId, req.id, itemId, at),
          // a request reopened by this rejection must not also get a stale reminder
          db
            .prepare("UPDATE requests SET next_reminder_at = ? WHERE firm_id = ? AND id = ? AND next_reminder_at IS NOT NULL AND next_reminder_at <= ?")
            .bind(nextReminder(at, req.deadline, c.get("firm").tz, false), firmId, req.id, at),
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
  const row = await db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`).bind(itemId).first<any>();
  return c.json(presentItem(row));
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
    db
      .prepare(`UPDATE requests SET status = 'closed', closed_at = ?, ${endNow} WHERE firm_id = ? AND id = ? AND status != 'closed'`)
      .bind(now, now, now, firmId, req.id),
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
  const free = "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND deleted_at IS NULL AND hold_at IS NULL)";
  const [, res] = await db.batch([
    audit(c, "request.delete", "request", req.id, undefined, { sql: free, binds: [firmId, req.id] }),
    db.prepare("UPDATE requests SET deleted_at = ? WHERE firm_id = ? AND id = ? AND deleted_at IS NULL AND hold_at IS NULL").bind(now, firmId, req.id),
    db
      .prepare(`UPDATE links SET revoked_at = ? WHERE firm_id = ? AND request_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND deleted_at IS NOT NULL)`)
      .bind(now, firmId, req.id, firmId, req.id),
  ]);
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: "legal_hold" }, 409);
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
    if (![...(await sendersOf(c.env, firm.region as Region, [firm.id])).values()][0]?.owner_email) return c.json({ error: "sender_needed" }, 400);
    const client = await db
      .prepare("SELECT name, email, email_ok_at, email_stop_at FROM clients WHERE firm_id = ? AND id = ? AND deleted_at IS NULL")
      .bind(firm.id, req.client_id)
      .first<{ name: string; email: string | null; email_ok_at: number | null; email_stop_at: number | null }>();
    if (!client?.email || !client.email_ok_at) return c.json({ error: "client_email_needed" }, 400);
    if (client.email_stop_at) return c.json({ error: "client_unsubscribed" }, 400);
    if (await addressStopped(c.env, db, firm.id, client.email)) return c.json({ error: "client_unsubscribed" }, 400);
    // before the link is rotated, so a refusal leaves the client's working link alone
    if (!(await hasRoom(c.env, db, firm.id, req.id, now))) return c.json({ error: "email_limit" }, 429);
    invitee = { name: client.name, email: client.email };
  }

  const userId = c.get("session")!.userId;
  const token = `${firm.region}_${randomToken()}`;
  const hash = await hmac(c.env.HASH_KEY, token.slice(firm.region.length + 1));
  const results = await db.batch([
    db.prepare(`UPDATE links SET revoked_at = ? WHERE firm_id = ? AND request_id = ? AND revoked_at IS NULL AND ${LIVE}`).bind(now, firm.id, req.id, firm.id, req.id),
    db
      .prepare(
        `INSERT INTO links (token_hash, firm_id, request_id, expires_at, created_by, created_at, token_enc) SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE ${LIVE} AND NOT EXISTS (SELECT 1 FROM firm_settings WHERE firm_id = ? AND closed_at IS NOT NULL)`,
      )
      .bind(hash, firm.id, req.id, req.deadline + LINK_GRACE, userId, now, await sealToken(c.env, token), firm.id, req.id, firm.id),
    db
      .prepare(
        `INSERT INTO audit (id, firm_id, at, actor_type, actor_id, action, object_type, object_id)
         SELECT ?, ?, ?, 'user', ?, 'link.create', 'request', ? WHERE ${LIVE}`,
      )
      .bind(randomId(), firm.id, now, userId, req.id, firm.id, req.id),
    db
      .prepare(
        `UPDATE requests SET status = CASE WHEN status = 'draft' THEN 'open' ELSE status END, sent_at = ?, firm_name = ?, tz = ?,
           next_reminder_at = CASE WHEN reminders_on = 1 THEN ? ELSE NULL END
         WHERE firm_id = ? AND id = ? AND status IN ('draft', 'open', 'complete') AND deleted_at IS NULL`,
      )
      .bind(now, firm.name, firm.tz, nextReminder(now, req.deadline, firm.tz, true), firm.id, req.id),
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
        unsubUrl: await unsubUrl(c.env, firm.region as Region, req.client_id, firm.id, invitee.email),
      },
      now,
    );
    if (outcome === "sent") return c.json({ url, emailed: true });
    // a parallel send took the last slot after the check above; the link is made, so it comes back to share another way
  } catch (e) {
    console.error(e instanceof Error ? e.message : "error");
  }
  return c.json({ url, email_failed: true });
});

requests.get("/requests/:id/messages", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const { results } = await c.get("db")
    .prepare("SELECT id, kind, seq, status, sent_at, seq >= ? AS manual FROM messages WHERE firm_id = ? AND request_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT 100")
    .bind(MANUAL_SEQ, c.get("firm").id, req.id)
    .all();
  return c.json(results);
});
