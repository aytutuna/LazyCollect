import { Hono, type Context } from "hono";
import { audit } from "./audit";
import { insertRows } from "./copy";
import { MAX_ITEMS, expandItems, matches, relabel, rowsFor, parsePeople, type Blueprint, type Person, type Row } from "./expand";
import { deadlineDay, flagOf, today } from "./expiry";
import { ownsExamples, parseExample } from "./examples";
import { usable } from "./firm";
import { FILE_COLUMNS, holdFiles, type FileRow } from "./held";
import { LINK_GRACE, sealToken } from "./links";
import { MANUAL_SEQ, addressStopped, deliver, hasRoom, unsubUrl } from "./mail";
import { ITEM_COLS, conditionOk, isQuestion, parseDay, presentItem } from "./questions";
import { regionOf, type Region } from "./regions";
import { parseReasons } from "./reasons";
import { listRequests } from "./search";
import { missingItems, senderName, sendersOf } from "./reminders";
import { endNow, syncStatus } from "./status";
import { nextReminder } from "./tz";
import type { AppEnv } from "./session";
import { UnknownYear, hasMarkers, resolveItems, taxYears, validYear } from "./taxyear";
import { builtinTemplates, factsOf, parseItem, parseItems, type Item } from "./templates";
import { DAY, hmac, randomId, randomToken } from "./util";
import { exampleGone, invalid, maybe, notFound, readBody, setClause, text } from "./validate";

export const requests = new Hono<AppEnv>();

const COLS = "id, client_id, title, note, deadline, firm_name, status, sent_at, closed_at, created_at, first_opened_at, reminders_on, next_reminder_at, ended_at, keep_until, hold_at";
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
  const people = body.people === undefined ? [] : parsePeople(body.people);
  const validUntil = "valid_until" in body ? parseDay(body.valid_until) : null;
  const taxYear = body.tax_year === undefined ? null : body.tax_year;
  const templateRef = body.template_ref === undefined ? (typeof body.template_id === "string" ? body.template_id : null) : body.template_ref;
  if (!people || validUntil === undefined) return invalid(c);
  if ((taxYear !== null && !validYear(taxYear)) || (templateRef !== null && (typeof templateRef !== "string" || templateRef.length > 64))) return invalid(c);
  const db = c.get("db");
  const firmId = c.get("firm").id;

  const client = await db
    .prepare("SELECT id FROM clients WHERE firm_id = ? AND id = ? AND deleted_at IS NULL")
    .bind(firmId, body.client_id)
    .first();
  if (!client) return notFound(c);

  let items: (Item & { tpl?: string })[] = [];
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
    if (!(await ownsExamples(db, firmId, parsed.map((i) => i.example)))) return exampleGone(c);
    items = parsed;
  }
  // the markers of a checklist are filled in for the tax year the account picked
  const facts = await factsOf(db, firmId, templateRef);
  if (hasMarkers(items, facts)) {
    if (taxYear === null) return c.json({ error: "tax_year_needed" }, 400);
    if (!taxYears(items, facts).includes(taxYear)) return c.json({ error: "tax_year_unknown" }, 400);
    try {
      items = resolveItems(items, taxYear, facts);
    } catch (e) {
      if (e instanceof UnknownYear) return c.json({ error: "tax_year_unknown" }, 400);
      throw e;
    }
  }

  const id = randomId();
  const now = Date.now();
  const { rows, perPerson } = expandItems(items, people, today(now, c.get("firm").tz).today);
  if (rows.length > MAX_ITEMS) return c.json({ error: "too_many_items" }, 409);
  const made = { sql: "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ?)", binds: [firmId, id] };
  const [res] = await db.batch([
    db
      .prepare(
        `INSERT INTO requests (id, firm_id, client_id, title, note, deadline, created_by, created_at, per_person_json, valid_until, tax_year, template_ref) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${SINGLE_TODAY}`,
      )
      .bind(id, firmId, body.client_id, title, note, due, c.get("session")!.userId, now, perPerson.length ? JSON.stringify(perPerson) : null, validUntil, taxYear, templateRef, firmId, now - DAY, firmId),
    db
      .prepare(
        `INSERT INTO people (id, firm_id, request_id, position, role, name, dob, created_at)
         SELECT lower(hex(randomblob(16))), ?1, ?2, json_extract(value, '$.position'), json_extract(value, '$.role'), json_extract(value, '$.name'), json_extract(value, '$.dob'), ?3
         FROM json_each(?4) WHERE EXISTS (SELECT 1 FROM requests WHERE firm_id = ?1 AND id = ?2)`,
      )
      .bind(firmId, id, now, JSON.stringify(people)),
    insertRows(db, firmId, [id], rows),
    audit(c, "request.create", "request", id, undefined, made),
  ]);
  if (!res.meta.changes) return c.json({ error: "too_many_requests" }, 429);
  return c.json(await loadRequest(c, id), 201);
});

export async function loadRequest(c: Context<AppEnv>, id: string) {
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const now = today(Date.now(), c.get("firm").tz);
  const day = deadlineDay("requests", now.offset);
  const { per_person_json, valid_until, must_last, deadline_day, ...row } = (await db
    .prepare(`SELECT ${COLS}, per_person_json, valid_until, COALESCE(valid_until, date(${day}, '+6 months')) AS must_last, ${day} AS deadline_day FROM requests WHERE firm_id = ? AND id = ?`)
    .bind(firmId, id)
    .first<any>())!;
  const { results: people } = await db
    .prepare("SELECT id, position, role, name, dob FROM people WHERE firm_id = ? AND request_id = ? ORDER BY position")
    .bind(firmId, id)
    .all();
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
    reminders_on: row.reminders_on === 1,
    valid_until: must_last as string,
    valid_until_set: valid_until !== null,
    per_person_items: per_person_json ? (JSON.parse(per_person_json) as unknown[]).length : 0,
    people,
    items: results.map((i) => ({
      ...presentItem(i),
      expiry_flag: flagOf({ status: i.status, valid_to: i.valid_to, hidden: i.hidden === 1 }, i.expiry_rule === "issue" ? deadline_day : must_last, now),
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
  if ("valid_until" in body) {
    const day = parseDay(body.valid_until);
    if (day === undefined) return invalid(c);
    fields.valid_until = day;
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

export const editable = (req: Req) => req.status === "draft" || req.status === "open" || req.status === "complete";

// repeated in the write itself so a close that lands after the read still wins
export const LIVE = "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('draft', 'open', 'complete') AND deleted_at IS NULL)";

async function refused(c: Context<AppEnv>) {
  const req = await findRequest(c);
  return req && !editable(req) ? c.json({ error: "locked" }, 409) : notFound(c);
}

// an item for each person, or one with a translation set, takes its places at the end of the request
async function addTagged(c: Context<AppEnv>, req: Req, item: Item) {
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const state = await db
    .prepare(
      `SELECT per_person_json, (SELECT COALESCE(MAX(position), -1) + 1 FROM items WHERE firm_id = ?1 AND request_id = ?2) AS base,
         (SELECT COUNT(*) FROM items WHERE firm_id = ?1 AND request_id = ?2) AS count FROM requests WHERE firm_id = ?1 AND id = ?2`,
    )
    .bind(firmId, req.id)
    .first<{ per_person_json: string | null; base: number; count: number }>();
  const { results: people } = await db
    .prepare("SELECT position, role, name, dob FROM people WHERE firm_id = ? AND request_id = ? ORDER BY position")
    .bind(firmId, req.id)
    .all<Person>();
  const now = today(Date.now(), c.get("firm").tz).today;
  const rows: Row[] = [];
  const key = randomId();
  if (item.per_person) {
    for (const p of people) if (matches(item.per_person, p, now)) rows.push(...rowsFor(item, p, state!.base + rows.length, null, key));
  } else {
    rows.push(...rowsFor(item, null, state!.base, null));
  }
  if (state!.count + rows.length > MAX_ITEMS) return c.json({ error: "too_many_items" }, 409);
  const live = { sql: LIVE, binds: [firmId, req.id] };
  const kept = item.per_person ? JSON.stringify([...(state!.per_person_json ? JSON.parse(state!.per_person_json) : []), { ...item, key }]) : null;
  const [res] = await db.batch([
    kept
      ? db.prepare(`UPDATE requests SET per_person_json = ? WHERE firm_id = ? AND id = ? AND status IN ('draft', 'open', 'complete') AND deleted_at IS NULL`).bind(kept, firmId, req.id)
      : insertRows(db, firmId, [req.id], rows, live),
    ...(kept ? [insertRows(db, firmId, [req.id], rows, live)] : []),
    audit(c, "item.add", "request", req.id, { request: req.id }, live),
    syncStatus(db, firmId, req.id),
  ]);
  if (!res.meta.changes) return refused(c);
  return c.json(await loadRequest(c, req.id), 201);
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
  if (!(await ownsExamples(db, firmId, [item.example]))) return exampleGone(c);
  if (item.per_person || item.translation) return addTagged(c, req, item);
  if (item.show_if) {
    // here the condition names a position that is already in the request
    const p = await db
      .prepare("SELECT kind, options_json, show_if_pos, person_pos, companion FROM items WHERE firm_id = ? AND request_id = ? AND position = ?")
      .bind(firmId, req.id, item.show_if.item)
      .first<{ kind: string; options_json: string | null; show_if_pos: number | null; person_pos: number | null; companion: string | null }>();
    if (!conditionOk(item.show_if, p ? { kind: p.kind, options: p.options_json ? JSON.parse(p.options_json) : null, conditional: p.show_if_pos !== null || p.person_pos !== null || p.companion !== null } : undefined)) return invalid(c);
  }
  const [res] = await db.batch([
    db
      .prepare(
        `INSERT INTO items (id, firm_id, request_id, position, label, help, required, kind, options_json, show_if_pos, show_if_value, example, expiry_rule, valid_months)
         SELECT ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM items WHERE firm_id = ? AND request_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${LIVE} AND (SELECT COUNT(*) FROM items WHERE firm_id = ? AND request_id = ?) < ${MAX_ITEMS}`,
      )
      .bind(
        id, firmId, req.id, firmId, req.id, item.label, item.help ?? null, item.required ? 1 : 0,
        item.kind ?? "file", item.options ? JSON.stringify(item.options) : null, item.show_if?.item ?? null, item.show_if?.value ?? null, item.example ?? null,
        item.expiry ?? null, item.valid_months ?? null,
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
  for (const date of ["expires_on", "issued_on"]) {
    if (!(date in body)) continue;
    const day = parseDay(body[date]);
    if (day === undefined) return invalid(c);
    fields[date] = day;
  }
  if ("valid_months" in body) {
    const n = body.valid_months;
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 120) return invalid(c);
    fields.valid_months = n as number;
  }
  if (!Object.keys(fields).length) return invalid(c);
  const req = await findRequest(c);
  if (!req) return notFound(c);
  if (!editable(req)) return c.json({ error: "locked" }, 409);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  if (!(await ownsExamples(db, firmId, [fields.example as string | null]))) return exampleGone(c);
  const itemId = c.req.param("itemId");
  const cur = await db
    .prepare("SELECT label, label_base, expiry_rule, blueprint FROM items WHERE firm_id = ? AND request_id = ? AND id = ?")
    .bind(firmId, req.id, itemId)
    .first<{ label: string; label_base: string | null; expiry_rule: string | null; blueprint: string | null }>();
  if (!cur) return notFound(c);
  // a label sent back as it was is not a rename
  if (fields.label === (cur.label_base ?? cur.label)) delete fields.label;
  // the dates belong to documents that ask for them, and the months only to one counted from its issue date
  if (["expires_on", "issued_on", "valid_months"].some((k) => k in fields)) {
    if (!cur.expiry_rule || ("valid_months" in fields && cur.expiry_rule !== "issue")) return invalid(c);
  }
  if (!Object.keys(fields).length) return c.json(presentItem((await db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`).bind(itemId).first<any>())!));
  // wording the account changed is no longer a template's, so Repeat leaves it alone
  const changed = Object.keys(fields);
  const set = setClause("label" in fields || "help" in fields ? { ...fields, tpl_json: null } : fields);
  // the items still to be made for people added later follow what was changed
  let kept: string | null = null;
  if (cur.blueprint && ("label" in fields || "help" in fields || "required" in fields)) {
    const json = (await db.prepare("SELECT per_person_json FROM requests WHERE firm_id = ? AND id = ?").bind(firmId, req.id).first<{ per_person_json: string | null }>())?.per_person_json;
    if (json) {
      const list = (JSON.parse(json) as Blueprint[]).map((b) => {
        if (b.key !== cur.blueprint) return b;
        const { help: _help, ...rest } = b;
        const help = "help" in fields ? (fields.help as string | null) : b.help;
        return { ...rest, ...(help ? { help } : {}), label: "label" in fields ? (fields.label as string) : b.label, required: "required" in fields ? fields.required === 1 : b.required };
      });
      kept = JSON.stringify(list);
    }
  }
  const [res] = await db.batch([
    db
      .prepare(`UPDATE items SET ${set.sql} WHERE firm_id = ? AND request_id = ? AND id = ? AND ${LIVE}`)
      .bind(...set.values, firmId, req.id, itemId, firmId, req.id),
    audit(c, "item.edit", "item", itemId, { request: req.id, fields: changed }, {
      sql: `EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ?) AND ${LIVE}`,
      binds: [firmId, req.id, itemId, firmId, req.id],
    }),
    syncStatus(db, firmId, req.id),
    ...("label" in fields
      ? [
          // a renamed document keeps its person's name, and a companion follows it; a companion renamed by hand stops following
          db.prepare("UPDATE items SET label_base = ? WHERE firm_id = ? AND request_id = ? AND id = ? AND label_base IS NOT NULL AND companion IS NULL").bind(fields.label, firmId, req.id, itemId),
          db.prepare("UPDATE items SET companion = NULL WHERE firm_id = ? AND request_id = ? AND id = ?").bind(firmId, req.id, itemId),
          ...relabel(db, firmId, req.id),
        ]
      : []),
    ...(kept ? [db.prepare("UPDATE requests SET per_person_json = ? WHERE firm_id = ? AND id = ?").bind(kept, firmId, req.id)] : []),
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
    .prepare("SELECT status, position, blueprint FROM items WHERE firm_id = ? AND request_id = ? AND id = ?")
    .bind(c.get("firm").id, req.id, c.req.param("itemId"))
    .first<{ status: string; position: number; blueprint: string | null }>();
  if (!item) return notFound(c);
  if (item.status !== "empty") return c.json({ error: "has_upload" }, 409);
  const translated = await db
    .prepare("SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND for_pos = ? AND companion = 'question' AND answer IS NOT NULL")
    .bind(c.get("firm").id, req.id, item.position)
    .first();
  if (translated) return c.json({ error: "has_translation" }, 409);
  // a document's translation question and companions go with it, unless the client has already answered or uploaded there
  const started = await db
    .prepare("SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND for_pos = ? AND (status != 'empty' OR EXISTS (SELECT 1 FROM files WHERE firm_id = items.firm_id AND item_id = items.id AND deleted_at IS NULL))")
    .bind(c.get("firm").id, req.id, item.position)
    .first();
  if (started) return c.json({ error: "has_dependents" }, 409);
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
  const removed = await db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE firm_id = ? AND item_id = ? AND deleted_at IS NOT NULL`).bind(firmId, itemId).all<FileRow>();
  await holdFiles(c.env, firm.region as Region, removed.results, "removed");
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
    db
      .prepare(`DELETE FROM items WHERE firm_id = ? AND request_id = ? AND for_pos = ? AND ${bare} AND NOT EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ?)`)
      .bind(firmId, req.id, item.position, firmId, req.id, itemId),
    syncStatus(db, firmId, req.id),
  ]);
  const keys = (gone.results as { r2_key: string }[]).map((f) => f.r2_key);
  if (keys.length) await regionOf(c.env, firm.region as Region).bucket.delete(keys);
  if (res.meta.changes) {
    // when no one has the item any more, what was kept for people added later goes too
    if (item.blueprint && !(await db.prepare("SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND blueprint = ?").bind(firmId, req.id, item.blueprint).first())) {
      const json = (await db.prepare("SELECT per_person_json FROM requests WHERE firm_id = ? AND id = ?").bind(firmId, req.id).first<{ per_person_json: string | null }>())?.per_person_json;
      const rest = json ? (JSON.parse(json) as Blueprint[]).filter((b) => b.key !== item.blueprint) : [];
      await db.prepare("UPDATE requests SET per_person_json = ? WHERE firm_id = ? AND id = ?").bind(rest.length ? JSON.stringify(rest) : null, firmId, req.id).run();
    }
    return c.json({ ok: true });
  }
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
      .prepare(`UPDATE items SET status = ?, reject_note = ?, reject_reasons = ?, reviewed_by = ?, reviewed_at = ?${reasons.includes("expired") ? ", expires_on = NULL, issued_on = NULL" : ""} WHERE firm_id = ? AND request_id = ? AND id = ? AND ${ready} AND ${same}`)
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
      .prepare("SELECT name, email, email_ok_at, email_stop_at, email_bounced_at FROM clients WHERE firm_id = ? AND id = ? AND deleted_at IS NULL")
      .bind(firm.id, req.client_id)
      .first<{ name: string; email: string | null; email_ok_at: number | null; email_stop_at: number | null; email_bounced_at: number | null }>();
    if (!client?.email || !client.email_ok_at) return c.json({ error: "client_email_needed" }, 400);
    if (client.email_bounced_at) return c.json({ error: "client_bounced" }, 400);
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
    .prepare("SELECT id, kind, seq, status, sent_at, bounced_at, seq >= ? AS manual FROM messages WHERE firm_id = ? AND request_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT 100")
    .bind(MANUAL_SEQ, c.get("firm").id, req.id)
    .all();
  return c.json(results);
});
