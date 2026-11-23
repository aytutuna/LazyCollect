import { Hono } from "hono";
import { audit } from "./audit";
import { MAX_ITEMS, MAX_PEOPLE, ROLES, matches, parsePerson, relabel, rowsFor, type Person, type Row } from "./expand";
import { insertRows } from "./copy";
import { today } from "./expiry";
import { parseDay } from "./questions";
import { regionOf, type Region } from "./regions";
import { LIVE, editable, findRequest, loadRequest } from "./requests";
import type { AppEnv } from "./session";
import { syncStatus } from "./status";
import { randomId } from "./util";
import { invalid, notFound, readBody, setClause, text } from "./validate";
import type { Item } from "./questions";

export const people = new Hono<AppEnv>();

// the items waiting for people are added for the new one, after what the request already has
people.post("/requests/:id/people", async (c) => {
  const body = await readBody(c);
  const person = body && parsePerson(body);
  if (!person) return invalid(c);
  const req = await findRequest(c);
  if (!req) return notFound(c);
  if (!editable(req)) return c.json({ error: "locked" }, 409);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const state = await db
    .prepare(
      `SELECT per_person_json,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM people WHERE firm_id = ?1 AND request_id = ?2) AS next,
         (SELECT COUNT(*) FROM people WHERE firm_id = ?1 AND request_id = ?2) AS people,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM items WHERE firm_id = ?1 AND request_id = ?2) AS base,
         (SELECT COUNT(*) FROM items WHERE firm_id = ?1 AND request_id = ?2) AS items
       FROM requests WHERE firm_id = ?1 AND id = ?2`,
    )
    .bind(firmId, req.id)
    .first<{ per_person_json: string | null; next: number; people: number; base: number; items: number }>();
  if (state!.people >= MAX_PEOPLE) return c.json({ error: "too_many_people" }, 409);
  const added: Person = { ...person, position: state!.next };
  const now = today(Date.now(), c.get("firm").tz).today;
  const rows: Row[] = [];
  for (const item of (state!.per_person_json ? JSON.parse(state!.per_person_json) : []) as Item[]) {
    if (matches(item.per_person!, added, now)) rows.push(...rowsFor(item, added, state!.base + rows.length, null));
  }
  if (state!.items + rows.length > MAX_ITEMS) return c.json({ error: "too_many_items" }, 409);
  const id = randomId();
  const live = { sql: LIVE, binds: [firmId, req.id] };
  const there = { sql: "EXISTS (SELECT 1 FROM people WHERE firm_id = ? AND id = ?)", binds: [firmId, id] };
  const [res] = await db.batch([
    db
      .prepare(`INSERT INTO people (id, firm_id, request_id, position, role, name, dob, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${LIVE}`)
      .bind(id, firmId, req.id, added.position, added.role, added.name, added.dob, Date.now(), firmId, req.id),
    insertRows(db, firmId, [req.id], rows, there),
    audit(c, "person.add", "person", id, { request: req.id }, there),
    syncStatus(db, firmId, req.id),
  ]);
  if (!res.meta.changes) return c.json({ error: "locked" }, 409);
  return c.json(await loadRequest(c, req.id), 201);
});

// A person's name, role and birth date can change. Their items keep the labels the name gave them; changing the role or the
// date does not add or take away items, so a person who was entered wrongly is removed and added again.
people.patch("/requests/:id/people/:personId", async (c) => {
  const body = await readBody(c);
  if (!body) return invalid(c);
  const fields: Record<string, string | null> = {};
  if ("name" in body) {
    const name = text(body.name, 100);
    if (!name) return invalid(c);
    fields.name = name;
  }
  if ("role" in body) {
    const role = ROLES.find((r) => r === body.role);
    if (!role) return invalid(c);
    fields.role = role;
  }
  if ("dob" in body) {
    const dob = parseDay(body.dob);
    if (dob === undefined) return invalid(c);
    fields.dob = dob;
  }
  if (!Object.keys(fields).length) return invalid(c);
  const req = await findRequest(c);
  if (!req) return notFound(c);
  if (!editable(req)) return c.json({ error: "locked" }, 409);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const personId = c.req.param("personId");
  const set = setClause(fields);
  const [res] = await db.batch([
    db.prepare(`UPDATE people SET ${set.sql} WHERE firm_id = ? AND request_id = ? AND id = ? AND ${LIVE}`).bind(...set.values, firmId, req.id, personId, firmId, req.id),
    audit(c, "person.edit", "person", personId, { request: req.id, fields: Object.keys(fields) }, {
      sql: `EXISTS (SELECT 1 FROM people WHERE firm_id = ? AND request_id = ? AND id = ?) AND ${LIVE}`,
      binds: [firmId, req.id, personId, firmId, req.id],
    }),
    ...relabel(db, firmId, req.id),
  ]);
  if (!res.meta.changes) return notFound(c);
  return c.json(await loadRequest(c, req.id));
});

// A person takes their items with them. When any of those hold files, answers or a decision, the account has to say so with ?confirm=1.
people.delete("/requests/:id/people/:personId", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  if (!editable(req)) return c.json({ error: "locked" }, 409);
  if (req.hold_at) return c.json({ error: "legal_hold" }, 409);
  const db = c.get("db");
  const firm = c.get("firm");
  const personId = c.req.param("personId");
  const person = await db.prepare("SELECT position FROM people WHERE firm_id = ? AND request_id = ? AND id = ?").bind(firm.id, req.id, personId).first<{ position: number }>();
  if (!person) return notFound(c);
  const items = "firm_id = ? AND request_id = ? AND person_pos = ?";
  const own = [firm.id, req.id, person.position] as const;
  const { n } = (await db
    .prepare(
      `SELECT COUNT(*) AS n FROM items WHERE ${items} AND (status != 'empty' OR EXISTS (SELECT 1 FROM files WHERE firm_id = items.firm_id AND item_id = items.id AND deleted_at IS NULL))`,
    )
    .bind(...own)
    .first<{ n: number }>())!;
  if (n && c.req.query("confirm") !== "1") return c.json({ error: "has_data", items: n }, 409);

  const free = "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('draft', 'open', 'complete') AND deleted_at IS NULL AND hold_at IS NULL)";
  const [, gone, , res] = await db.batch([
    audit(c, "person.remove", "person", personId, { request: req.id, items: n }, {
      sql: `EXISTS (SELECT 1 FROM people WHERE firm_id = ? AND id = ?) AND ${free}`,
      binds: [firm.id, personId, firm.id, req.id],
    }),
    db
      .prepare(`DELETE FROM files WHERE firm_id = ? AND request_id = ? AND item_id IN (SELECT id FROM items WHERE ${items}) AND ${free} RETURNING r2_key`)
      .bind(firm.id, req.id, ...own, firm.id, req.id),
    db.prepare(`DELETE FROM items WHERE ${items} AND ${free}`).bind(...own, firm.id, req.id),
    db.prepare(`DELETE FROM people WHERE firm_id = ? AND request_id = ? AND id = ? AND ${free}`).bind(firm.id, req.id, personId, firm.id, req.id),
    syncStatus(db, firm.id, req.id),
  ]);
  const keys = (gone.results as { r2_key: string }[]).map((f) => f.r2_key);
  if (keys.length) await regionOf(c.env, firm.region as Region).bucket.delete(keys);
  if (!res.meta.changes) return c.json({ error: "locked" }, 409);
  return c.json(await loadRequest(c, req.id));
});
