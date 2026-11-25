import { classOf, itemFailed } from "./pulse";
import { Hono, type Context } from "hono";
import { audit } from "./audit";
import { insertRows, itemColumns, itemsFromRequests, nextYearTitle, peopleFromRequests } from "./copy";
import { MAX_ITEMS, expandItems } from "./expand";
import { today } from "./expiry";
import { usable } from "./firm";
import { linkUrl } from "./links";
import { addressStopped, deliver, hasRoom, unsubUrl } from "./mail";
import { regionIds, regionOf, type Region } from "./regions";
import { canSend, missingItems, senderName, sendersOf, type Sender } from "./reminders";
import { deadline } from "./requests";
import type { AppEnv } from "./session";
import { PAGE, offsetOf } from "./search";
import { visible } from "./questions";
import { UnknownYear, hasMarkers, resolveItems, taxYears, validYear } from "./taxyear";
import { builtinTemplates, factsOf, type Item } from "./templates";
import { yearOn } from "./yearon";
import { addDays, atHour, dayOf, inHours, nextOpening, nextReminder, plusYear } from "./tz";
import { DAY, HOUR, MINUTE, randomId } from "./util";
import { invalid, notFound, readBody, text } from "./validate";

export const batches = new Hono<AppEnv>();

// one batch, and all batches of an account in any 24 hours; they do not count against the 300 requests a day made one by one
const MAX_BATCH = 1000;
const MAX_BATCH_PER_DAY = 2000;
const MAX_SEND_AHEAD = 90 * DAY;
// sends per cron run, so one run stays short
const PER_TICK = 30;
const MAX_TRIES = 3;
// rows per statement, so a bound list stays small
const CHUNK = 200;

const SEND_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

// "2027-02-01T09:00" read as the account's wall clock; null when it is not a real time
function localTime(v: string, tz: string): number | null {
  const m = SEND_AT_RE.exec(v);
  if (!m) return null;
  const [y, mo, d, h, min] = m.slice(1).map(Number);
  const check = new Date(Date.UTC(y, mo - 1, d, h, min));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== min) return null;
  return atHour({ y, m: mo, d }, h, tz) + min * MINUTE;
}

type Plan = { id: string; client_id: string; title: string; note: string | null; deadline: number; reminders_on: number; src: string | null; again?: 1; position: number; state: string; reason: string | null };

const hexIds = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && /^[0-9a-f]{32}$/.test(x)) ? [...new Set(v as string[])] : undefined;

const SUMMARY = `SELECT b.id, b.title, b.source_kind, b.source_name, b.deadline, b.reminders_on, b.send_at, b.status, b.total, b.limited_at, b.stop_reason, b.created_at, b.finished_at,
    COALESCE(SUM(i.state = 'pending'), 0) AS pending, COALESCE(SUM(i.state = 'sent'), 0) AS sent, COALESCE(SUM(i.state = 'no_email'), 0) AS no_email,
    COALESCE(SUM(i.state = 'skipped'), 0) AS skipped, COALESCE(SUM(i.state = 'failed'), 0) AS failed, COALESCE(SUM(i.state = 'cancelled'), 0) AS cancelled,
    COALESCE(SUM(r.first_opened_at IS NOT NULL), 0) AS opened, COALESCE(SUM(r.status = 'complete'), 0) AS complete,
    COALESCE(SUM(r.status IN ('open', 'complete') AND EXISTS (SELECT 1 FROM items it WHERE it.firm_id = r.firm_id AND it.request_id = r.id AND it.status IN ('submitted', 'unavailable') AND ${visible("it")})), 0) AS review
  FROM batches b LEFT JOIN batch_items i ON i.firm_id = b.firm_id AND i.batch_id = b.id
  LEFT JOIN requests r ON r.firm_id = i.firm_id AND r.id = i.request_id AND r.deleted_at IS NULL
  WHERE b.firm_id = ?`;

const present = (b: Record<string, unknown>) => ({ ...b, reminders_on: b.reminders_on === 1 });

async function loadBatch(c: Context<AppEnv>, id: string) {
  const row = await c.get("db").prepare(`${SUMMARY} AND b.id = ? GROUP BY b.id`).bind(c.get("firm").id, id).first();
  return row ? present(row) : null;
}

batches.post("/batches", async (c) => {
  const body = await readBody(c);
  if (!body) return invalid(c);
  const firm = c.get("firm");
  const now = Date.now();
  const title = text(body.title, 200);
  const sendAt = body.send_at === undefined || body.send_at === null ? now : typeof body.send_at === "string" ? localTime(body.send_at, firm.tz) : null;
  if (!title || typeof body.reminders_on !== "boolean" || sendAt === null) return invalid(c);
  if (sendAt < now - 5 * MINUTE) return c.json({ error: "send_in_past" }, 400);
  if (sendAt > now + MAX_SEND_AHEAD) return invalid(c);
  const repeat = body.request_ids !== undefined;
  const kinds = [body.template_id !== undefined, body.request_id !== undefined, repeat].filter(Boolean).length;
  const note = body.note === undefined || body.note === null || body.note === "" ? null : text(body.note, 2000);
  if (kinds !== 1 || note === undefined) return invalid(c);
  const taxYear = body.tax_year === undefined ? null : body.tax_year;
  if (taxYear !== null && !validYear(taxYear)) return invalid(c);
  const list = repeat ? body.request_ids : body.client_ids;
  if (Array.isArray(list) && list.length > MAX_BATCH) return c.json({ error: "batch_too_big" }, 400);
  const ids = hexIds(list);
  if (!ids) return invalid(c);

  if (!firm.name) return c.json({ error: "firm_profile" }, 400);
  if (!usable(firm, now)) return c.json({ error: "plan" }, 402);
  if (!firm.address) return c.json({ error: "address_needed" }, 400);
  const db = c.get("db");
  const [sender] = (await sendersOf(c.env, firm.region as Region, [firm.id])).values();
  if (!sender?.owner_email) return c.json({ error: "sender_needed" }, 400);

  const userId = c.get("session")!.userId;
  const batchId = randomId();
  let kind: "template" | "request" | "repeat" = "template";
  let sourceName: string | null = null;
  let due: number | null = null;
  let items: (Item & { tpl?: string })[] = [];
  let templateRef: string | null = null;
  let sourceId: string | null = null;
  const plans: Omit<Plan, "position" | "state" | "reason">[] = [];
  const mailable = new Map<string, boolean>();

  type ClientRow = { id: string; name: string; email: string | null; email_ok_at: number | null; email_stop_at: number | null; email_bounced_at: number | null };
  const loadClients = async (list: string[]) => {
    const { results } = await db
      .prepare("SELECT id, name, email, email_ok_at, email_stop_at, email_bounced_at FROM clients WHERE firm_id = ? AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY name COLLATE NOCASE, id")
      .bind(firm.id, JSON.stringify(list))
      .all<ClientRow>();
    for (const cl of results) mailable.set(cl.id, Boolean(cl.email && cl.email_ok_at && !cl.email_stop_at && !cl.email_bounced_at));
    return results;
  };

  if (repeat) {
    kind = "repeat";
    const { results } = await db
      .prepare(
        `SELECT r.id, r.client_id, r.title, r.note, r.deadline, r.reminders_on FROM requests r JOIN clients cl ON cl.firm_id = r.firm_id AND cl.id = r.client_id AND cl.deleted_at IS NULL
         WHERE r.firm_id = ? AND r.deleted_at IS NULL AND r.id IN (SELECT value FROM json_each(?)) ORDER BY cl.name COLLATE NOCASE, r.id`,
      )
      .bind(firm.id, JSON.stringify(ids))
      .all<{ id: string; client_id: string; title: string; note: string | null; deadline: number; reminders_on: number }>();
    if (results.length !== ids.length) return notFound(c);
    await loadClients([...new Set(results.map((r) => r.client_id))]);
    for (const r of results) {
      const next = plusYear(r.deadline, firm.tz);
      if (next <= now) return c.json({ error: "repeat_deadline_passed" }, 400);
      if (next <= sendAt) return c.json({ error: "deadline_before_send" }, 400);
      if (deadline(next) === undefined) return invalid(c);
      plans.push({ id: randomId(), client_id: r.client_id, title: nextYearTitle(r.title).slice(0, 200), note: r.note, deadline: next, reminders_on: body.reminders_on ? 1 : 0, src: r.id, again: 1 });
    }
  } else {
    due = deadline(body.deadline) ?? null;
    if (due === null) return invalid(c);
    if (due <= sendAt) return c.json({ error: "deadline_before_send" }, 400);
    const clients = await loadClients(ids);
    if (clients.length !== ids.length) return notFound(c);
    let sourceNote: string | null = null;
    if (body.template_id !== undefined) {
      if (typeof body.template_id !== "string") return invalid(c);
      const built = builtinTemplates.find((t) => t.id === body.template_id);
      if (built) {
        items = built.items;
        sourceName = built.name;
      } else {
        const row = await db.prepare("SELECT name, items_json FROM templates WHERE firm_id = ? AND id = ?").bind(firm.id, body.template_id).first<{ name: string; items_json: string }>();
        if (!row) return notFound(c);
        items = JSON.parse(row.items_json);
        sourceName = row.name;
      }
      templateRef = body.template_id;
      // the checklist's markers are filled in for the tax year the account picked
      const facts = await factsOf(db, firm.id, templateRef);
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
    } else {
      kind = "request";
      if (typeof body.request_id !== "string") return invalid(c);
      const src = await db.prepare("SELECT id, title, note FROM requests WHERE firm_id = ? AND id = ? AND deleted_at IS NULL").bind(firm.id, body.request_id).first<{ id: string; title: string; note: string | null }>();
      if (!src) return notFound(c);
      sourceId = src.id;
      sourceName = src.title;
      sourceNote = src.note;
    }
    const year = String(taxYear ?? dayOf(due, firm.tz).y);
    for (const cl of clients) {
      plans.push({
        id: randomId(),
        client_id: cl.id,
        title: title.replaceAll("{year}", year).replaceAll("{client}", cl.name).slice(0, 200),
        note: note ?? (kind === "request" ? sourceNote : null),
        deadline: due,
        reminders_on: body.reminders_on ? 1 : 0,
        src: sourceId,
      });
    }
  }

  // the whole batch or nothing: refused up front, before anything is written
  const since = now - DAY;
  const made = (await db.prepare("SELECT COALESCE(SUM(total), 0) AS n FROM batches WHERE firm_id = ? AND created_at > ?").bind(firm.id, since).first<{ n: number }>())!.n;
  if (made + plans.length > MAX_BATCH_PER_DAY) return c.json({ error: "batch_limit" }, 429);

  const columns = kind === "template" ? [] : await itemColumns(db);
  // a repeat moves on to the next tax year, or waits until that year's dates are known
  const later = kind === "repeat" ? await yearOn(db, firm.id, plans.map((p) => ({ id: p.id, src: p.src! }))) : [];
  if (later === "unknown") return c.json({ error: "tax_year_unknown" }, 409);
  // a template's items for each person wait for people the new requests do not have yet
  const expanded = expandItems(items, [], today(now, firm.tz).today);
  if (expanded.rows.length > MAX_ITEMS) return invalid(c);
  const rows: Plan[] = plans.map((p, position) => {
    const ok = mailable.get(p.client_id);
    return { ...p, position, state: ok ? "pending" : "no_email", reason: ok ? null : "no_email" };
  });
  const there = "EXISTS (SELECT 1 FROM batches WHERE firm_id = ? AND id = ?)";
  const stmts = [
    db
      .prepare(
        `INSERT INTO batches (id, firm_id, title, source_kind, source_name, deadline, reminders_on, send_at, next_try_at, total, created_by, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COALESCE(SUM(total), 0) FROM batches WHERE firm_id = ? AND created_at > ?) + ? <= ${MAX_BATCH_PER_DAY}`,
      )
      .bind(batchId, firm.id, title, kind, sourceName, due, body.reminders_on ? 1 : 0, sendAt, sendAt, rows.length, userId, now, firm.id, since, rows.length),
  ];
  for (let at = 0; at < rows.length; at += CHUNK) {
    const chunk = rows.slice(at, at + CHUNK);
    stmts.push(
      db
        .prepare(
          `INSERT INTO requests (id, firm_id, client_id, title, note, deadline, reminders_on, created_by, created_at, per_person_json, valid_until)
           SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.client_id'), json_extract(value, '$.title'), json_extract(value, '$.note'), json_extract(value, '$.deadline'),
             json_extract(value, '$.reminders_on'), ?2, ?3,
             CASE WHEN json_extract(value, '$.src') IS NULL THEN ?6 ELSE (SELECT per_person_json FROM requests WHERE firm_id = ?1 AND id = json_extract(value, '$.src')) END,
             CASE WHEN json_extract(value, '$.again') = 1 THEN (SELECT date(valid_until, '+1 year') FROM requests WHERE firm_id = ?1 AND id = json_extract(value, '$.src')) END
           FROM json_each(?4) WHERE EXISTS (SELECT 1 FROM batches WHERE firm_id = ?1 AND id = ?5)`,
        )
        .bind(firm.id, userId, now, JSON.stringify(chunk), batchId, expanded.perPerson.length ? JSON.stringify(expanded.perPerson) : null),
      ...(kind === "template"
        ? [insertRows(db, firm.id, chunk.map((p) => p.id), expanded.rows)]
        : [
            // a repeat is the same people a year on; a copy for other clients keeps only what is asked of everyone
            ...(kind === "repeat" ? [peopleFromRequests(db, firm.id, chunk.map((p) => ({ id: p.id, src: p.src! })), now)] : []),
            itemsFromRequests(db, firm.id, columns, chunk.map((p) => ({ id: p.id, src: p.src! })), kind === "repeat"),
          ]),
      db
        .prepare(
          `INSERT INTO batch_items (firm_id, batch_id, request_id, client_id, position, state, reason)
           SELECT ?1, ?2, json_extract(value, '$.id'), json_extract(value, '$.client_id'), json_extract(value, '$.position'), json_extract(value, '$.state'), json_extract(value, '$.reason')
           FROM json_each(?3) WHERE EXISTS (SELECT 1 FROM batches WHERE firm_id = ?1 AND id = ?2)`,
        )
        .bind(firm.id, batchId, JSON.stringify(chunk)),
    );
  }
  stmts.push(...later);
  // what the new requests were made for
  if (kind === "template" && (taxYear !== null || templateRef)) {
    stmts.push(
      db
        .prepare("UPDATE requests SET tax_year = ?, template_ref = ? WHERE firm_id = ? AND id IN (SELECT request_id FROM batch_items WHERE firm_id = ? AND batch_id = ?)")
        .bind(taxYear, templateRef, firm.id, firm.id, batchId),
    );
  }
  if (kind === "request") {
    stmts.push(
      db
        .prepare(
          `UPDATE requests SET tax_year = (SELECT tax_year FROM requests s WHERE s.firm_id = ?1 AND s.id = ?3), template_ref = (SELECT template_ref FROM requests s WHERE s.firm_id = ?1 AND s.id = ?3)
           WHERE firm_id = ?1 AND id IN (SELECT request_id FROM batch_items WHERE firm_id = ?1 AND batch_id = ?2)`,
        )
        .bind(firm.id, batchId, sourceId),
    );
  }
  stmts.push(
    audit(c, "batch.create", "batch", batchId, { kind, count: rows.length, send_at: sendAt, source: sourceId ?? body.template_id ?? null }, { sql: there, binds: [firm.id, batchId] }),
  );
  const res = await db.batch(stmts);
  if (!res[0].meta.changes) return c.json({ error: "batch_limit" }, 429);
  return c.json(await loadBatch(c, batchId), 201);
});

batches.get("/batches", async (c) => {
  const offset = offsetOf(c);
  if (offset === undefined) return invalid(c);
  const { results } = await c.get("db")
    .prepare(`${SUMMARY} GROUP BY b.id ORDER BY b.created_at DESC, b.id DESC LIMIT ${PAGE + 1} OFFSET ${offset}`)
    .bind(c.get("firm").id)
    .all();
  return c.json({ rows: results.slice(0, PAGE).map(present), next: results.length > PAGE ? offset + PAGE : null });
});

batches.get("/batches/:id", async (c) => {
  const row = await loadBatch(c, c.req.param("id"));
  return row ? c.json(row) : notFound(c);
});

const FILTERS: Record<string, string> = {
  all: "1",
  pending: "i.state = 'pending'",
  sent: "i.state = 'sent'",
  no_email: "i.state = 'no_email'",
  problem: "i.state IN ('skipped', 'failed')",
  opened: "r.first_opened_at IS NOT NULL",
  complete: "r.status = 'complete'",
  review: `r.status IN ('open', 'complete') AND EXISTS (SELECT 1 FROM items it WHERE it.firm_id = r.firm_id AND it.request_id = r.id AND it.status IN ('submitted', 'unavailable') AND ${visible("it")})`,
};

batches.get("/batches/:id/rows", async (c) => {
  const offset = offsetOf(c);
  const filter = c.req.query("filter") ?? "all";
  if (offset === undefined || !Object.hasOwn(FILTERS, filter)) return invalid(c);
  const { results } = await c.get("db")
    .prepare(
      `SELECT i.request_id, i.client_id, cl.name AS client_name, cl.email, i.state, i.reason, i.sent_at, r.title, r.status, r.deadline, r.first_opened_at,
         (SELECT COUNT(*) FROM items it WHERE it.firm_id = r.firm_id AND it.request_id = r.id AND it.status IN ('submitted', 'unavailable') AND ${visible("it")}) AS to_review
       FROM batch_items i JOIN requests r ON r.firm_id = i.firm_id AND r.id = i.request_id AND r.deleted_at IS NULL
       JOIN clients cl ON cl.firm_id = i.firm_id AND cl.id = i.client_id
       WHERE i.firm_id = ? AND i.batch_id = ? AND ${FILTERS[filter]} ORDER BY i.position LIMIT ${PAGE + 1} OFFSET ${offset}`,
    )
    .bind(c.get("firm").id, c.req.param("id"))
    .all();
  return c.json({ rows: results.slice(0, PAGE), next: results.length > PAGE ? offset + PAGE : null });
});

batches.post("/batches/:id/cancel", async (c) => {
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const id = c.req.param("id");
  const now = Date.now();
  const found = await db.prepare("SELECT status FROM batches WHERE firm_id = ? AND id = ?").bind(firmId, id).first<{ status: string }>();
  if (!found) return notFound(c);
  if (found.status === "done" || found.status === "cancelled") return c.json({ error: "batch_finished" }, 409);
  const [res, left] = await db.batch([
    db.prepare("UPDATE batches SET status = 'cancelled', finished_at = ? WHERE firm_id = ? AND id = ? AND status IN ('scheduled', 'sending')").bind(now, firmId, id),
    db
      .prepare(
        `UPDATE batch_items SET state = 'cancelled' WHERE firm_id = ? AND batch_id = ? AND state = 'pending'
         AND EXISTS (SELECT 1 FROM batches WHERE firm_id = ? AND id = ? AND status = 'cancelled' AND finished_at = ?)`,
      )
      .bind(firmId, id, firmId, id, now),
    audit(c, "batch.cancel", "batch", id, undefined, { sql: "EXISTS (SELECT 1 FROM batches WHERE firm_id = ? AND id = ? AND status = 'cancelled' AND finished_at = ?)", binds: [firmId, id, now] }),
  ]);
  if (!res.meta.changes) return c.json({ error: "batch_finished" }, 409);
  return c.json({ ok: true, unsent: left.meta.changes });
});

type Due = { id: string; firm_id: string; blocked_since: number | null };

// the first 9:00 of the next day, when earlier emails have left the 24 hour window
const tomorrow = (now: number, tz: string) => atHour(addDays(dayOf(now, tz), 1), 9, tz);
// a batch invite always takes slot 1, so a repeat after a failed write finds the row the first send made; invites sent by hand number from 1 as well but only on requests the batch skips
const INVITE_SEQ = 1;
const LEASE = 10 * MINUTE;
const BLOCKED_WAIT = 6 * HOUR;
const GIVE_UP = 30 * DAY;

// the account has not been able to send for a long time: what was not sent stays as drafts
async function stopBatch(db: D1Database, b: Due, reason: string, now: number) {
  await db.batch([
    db.prepare("UPDATE batches SET status = 'cancelled', finished_at = ?, stop_reason = ? WHERE firm_id = ? AND id = ? AND status IN ('scheduled', 'sending')").bind(now, reason, b.firm_id, b.id),
    db
      .prepare("UPDATE batch_items SET state = 'cancelled' WHERE firm_id = ? AND batch_id = ? AND state = 'pending' AND EXISTS (SELECT 1 FROM batches WHERE firm_id = ? AND id = ? AND status = 'cancelled' AND finished_at = ?)")
      .bind(b.firm_id, b.id, b.firm_id, b.id, now),
  ]);
}

type Row = {
  request_id: string;
  client_id: string;
  tries: number;
  linked_at: number | null;
  title: string;
  deadline: number;
  status: string;
  deleted_at: number | null;
  client_name: string;
  email: string | null;
  email_ok_at: number | null;
  email_stop_at: number | null;
  email_bounced_at: number | null;
  client_deleted: number | null;
};

const log = (e: unknown) => {
  console.error(e instanceof Error ? e.message : "error");
  itemFailed(classOf(e));
};

// Sends the invites of batches that have come due, a few at a time. A batch that runs into the daily email limit stops there and
// carries on in a later run, once earlier emails are more than 24 hours old.
export async function runBatches(env: Env, now = Date.now()) {
  for (const region of regionIds) {
    const { db } = regionOf(env, region);
    const { results } = await db
      .prepare("SELECT id, firm_id, blocked_since FROM batches WHERE status IN ('scheduled', 'sending') AND next_try_at <= ? ORDER BY next_try_at, created_at LIMIT 50")
      .bind(now)
      .all<Due>();
    const senders = await sendersOf(env, region, results.map((b) => b.firm_id));
    let budget = PER_TICK;
    // the run's invitations are shared equally among the accounts that have a batch due
    const share = Math.max(1, Math.floor(PER_TICK / new Set(results.map((b) => b.firm_id)).size));
    const taken = new Map<string, number>();
    const full = new Set<string>();
    // a batch that cannot go now is put off, so it stops taking one of the 50 places in every run
    const later = (b: Due, at: number, blocked = false) =>
      db
        .prepare("UPDATE batches SET next_try_at = ?, blocked_since = CASE WHEN ? THEN COALESCE(blocked_since, ?) ELSE NULL END WHERE firm_id = ? AND id = ? AND status IN ('scheduled', 'sending')")
        .bind(at, blocked ? 1 : 0, now, b.firm_id, b.id)
        .run();
    for (const b of results) {
      if (budget <= 0) break;
      try {
        const sender = senders.get(b.firm_id);
        if (!canSend(sender, now)) {
          if (b.blocked_since !== null && now - b.blocked_since > GIVE_UP) await stopBatch(db, b, "cannot_send", now);
          else await later(b, now + BLOCKED_WAIT, true);
        } else if (!inHours(now, sender.tz)) {
          await later(b, nextOpening(now, sender.tz));
        } else if (full.has(b.firm_id)) {
          await later(b, tomorrow(now, sender.tz));
        } else {
          const room = Math.min(budget, share - (taken.get(b.firm_id) ?? 0));
          if (room <= 0) continue;
          const left = await sendSome(env, region, db, b, sender, room, now);
          budget -= left.used;
          taken.set(b.firm_id, (taken.get(b.firm_id) ?? 0) + left.used);
          if (left.full) full.add(b.firm_id);
          // the end of the queue for the next run, or a day out when the daily limit was reached
          await later(b, left.full ? tomorrow(now, sender.tz) : left.busy ? now + 15 * MINUTE : now);
        }
      } catch (e) {
        log(e);
      }
    }
  }
}

async function sendSome(env: Env, region: Region, db: D1Database, b: Due, sender: Sender & { address: string; owner_email: string }, budget: number, now: number) {
  const claim = await db.prepare("UPDATE batches SET status = 'sending' WHERE firm_id = ? AND id = ? AND status IN ('scheduled', 'sending')").bind(b.firm_id, b.id).run();
  if (!claim.meta.changes) return { used: 0, full: false, busy: false };
  const { results } = await db
    .prepare(
      `SELECT i.request_id, i.client_id, i.tries, i.linked_at, r.title, r.deadline, r.status, r.deleted_at, cl.name AS client_name, cl.email, cl.email_ok_at, cl.email_stop_at, cl.email_bounced_at, cl.deleted_at AS client_deleted
       FROM batch_items i JOIN requests r ON r.firm_id = i.firm_id AND r.id = i.request_id JOIN clients cl ON cl.firm_id = i.firm_id AND cl.id = i.client_id
       WHERE i.firm_id = ? AND i.batch_id = ? AND i.state = 'pending' ORDER BY i.position LIMIT ?`,
    )
    .bind(b.firm_id, b.id, budget)
    .all<Row>();

  const settle = (r: Row, state: string, reason: string) =>
    db.prepare("UPDATE batch_items SET state = ?, reason = ? WHERE firm_id = ? AND request_id = ? AND state = 'pending'").bind(state, reason, b.firm_id, r.request_id).run();

  // a row is held for a while by the run that sends it, and only while the batch is still sending
  const hold = async (r: Row) =>
    (
      await db
        .prepare(
          `UPDATE batch_items SET reason = ? WHERE firm_id = ? AND request_id = ? AND state = 'pending'
           AND (reason IS NULL OR reason NOT LIKE 'sending:%' OR CAST(substr(reason, 9) AS INTEGER) < ?)
           AND EXISTS (SELECT 1 FROM batches WHERE firm_id = ? AND id = ? AND status = 'sending')`,
        )
        .bind(`sending:${now}`, b.firm_id, r.request_id, now - LEASE, b.firm_id, b.id)
        .run()
    ).meta.changes > 0;

  let used = 0;
  let full = false;
  let busy = false;
  for (const r of results) {
    used++;
    try {
      if (r.deleted_at || r.client_deleted || !["draft", "open", "complete"].includes(r.status)) {
        await settle(r, "skipped", "closed");
      } else if (r.status !== "draft" && !r.linked_at) {
        // sent by hand since the batch was made
        await settle(r, "skipped", "already_sent");
      } else if (r.deadline <= now) {
        await settle(r, "skipped", "deadline_passed");
      } else if (!r.email || !r.email_ok_at || r.email_stop_at || r.email_bounced_at || (await addressStopped(env, db, b.firm_id, r.email))) {
        await settle(r, "no_email", "no_email");
      } else if (!(await hasRoom(env, db, b.firm_id, r.request_id, now))) {
        full = true;
        break;
      } else if (!(await hold(r))) {
        // another run has this row, or the batch was stopped since it was read
        continue;
      } else {
        if (r.status === "draft") {
          await db.batch([
            db
              .prepare(
                `UPDATE requests SET status = 'open', sent_at = ?, firm_name = ?, tz = ?, next_reminder_at = CASE WHEN reminders_on = 1 THEN ? ELSE NULL END
                 WHERE firm_id = ? AND id = ? AND status = 'draft' AND deleted_at IS NULL`,
              )
              .bind(now, sender.name ?? senderName(sender), sender.tz, nextReminder(now, r.deadline, sender.tz, true), b.firm_id, r.request_id),
            db
              .prepare("UPDATE batch_items SET linked_at = ? WHERE firm_id = ? AND request_id = ? AND EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status != 'draft')")
              .bind(now, b.firm_id, r.request_id, b.firm_id, r.request_id),
          ]);
        }
        const url = await linkUrl(env, db, region, b.firm_id, r.request_id, r.deadline, now);
        const { outcome } = await deliver(
          env,
          { db, firmId: b.firm_id, requestId: r.request_id, clientId: r.client_id, kind: "invite", seq: INVITE_SEQ },
          {
            kind: "invite",
            sender: senderName(sender),
            address: sender.address,
            phone: sender.phone,
            replyTo: sender.owner_email,
            clientName: r.client_name,
            clientEmail: r.email,
            title: r.title,
            deadline: r.deadline,
            tz: sender.tz,
            items: await missingItems(db, b.firm_id, r.request_id, false),
            url,
            unsubUrl: await unsubUrl(env, region, r.client_id, b.firm_id, r.email),
          },
          now,
        );
        if (outcome === "sent" || outcome === "done") {
          await db.batch([
            db.prepare("UPDATE batch_items SET state = 'sent', reason = NULL, sent_at = ? WHERE firm_id = ? AND request_id = ? AND state = 'pending'").bind(now, b.firm_id, r.request_id),
            db.prepare("UPDATE batches SET limited_at = NULL WHERE firm_id = ? AND id = ?").bind(b.firm_id, b.id),
            db
              .prepare("INSERT INTO audit (id, firm_id, at, actor_type, action, object_type, object_id, meta) VALUES (?, ?, ?, 'system', 'batch.send', 'request', ?, ?)")
              .bind(randomId(), b.firm_id, now, r.request_id, JSON.stringify({ request: r.request_id, batch: b.id })),
          ]);
        } else if (outcome === "capped") {
          await db.prepare("UPDATE batch_items SET reason = NULL WHERE firm_id = ? AND request_id = ? AND state = 'pending'").bind(b.firm_id, r.request_id).run();
          full = true;
          break;
        } else {
          // provider trouble: a few more runs may get it through
          const tries = r.tries + 1;
          await db
            .prepare("UPDATE batch_items SET tries = ?, state = CASE WHEN ? >= ? THEN 'failed' ELSE state END, reason = CASE WHEN ? >= ? THEN 'send_failed' ELSE NULL END WHERE firm_id = ? AND request_id = ? AND state = 'pending'")
            .bind(tries, tries, MAX_TRIES, tries, MAX_TRIES, b.firm_id, r.request_id)
            .run();
          if (outcome === "later") {
            busy = true;
            break;
          }
        }
      }
    } catch (e) {
      log(e);
    }
  }
  if (full) await db.prepare("UPDATE batches SET limited_at = ? WHERE firm_id = ? AND id = ?").bind(now, b.firm_id, b.id).run();
  await db
    .prepare(
      `UPDATE batches SET status = 'done', finished_at = ?, limited_at = NULL WHERE firm_id = ? AND id = ? AND status = 'sending'
       AND NOT EXISTS (SELECT 1 FROM batch_items WHERE firm_id = ? AND batch_id = ? AND state = 'pending')`,
    )
    .bind(now, b.firm_id, b.id, b.firm_id, b.id)
    .run();
  return { used, full, busy };
}
