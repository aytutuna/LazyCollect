import { Hono } from "hono";
import { audit } from "./audit";
import { normalizeEmail } from "./auth";
import type { AppEnv } from "./session";
import { endNow } from "./status";
import { randomId } from "./util";
import { blank, invalid, locale, maybe, notFound, readBody, setClause, text } from "./validate";

export const clients = new Hono<AppEnv>();

const COLS = "id, name, email, phone, locale, email_ok_at, email_stop_at, sms_ok_at, consent_by, created_at";
const PHONE_RE = /^[\d\s()+.-]{7,40}$/;

const CHANNELS = [["email_ok_at", "email"], ["sms_ok_at", "sms"]] as const;

type ClientRow = { id: string; email: string | null; phone: string | null; email_ok_at: number | null; sms_ok_at: number | null };

function phone(v: unknown): string | null | undefined {
  const p = maybe(v, 40);
  return p && !PHONE_RE.test(p) ? undefined : p;
}

clients.get("/clients", async (c) => {
  const { results } = await c.get("db")
    .prepare(`SELECT ${COLS} FROM clients WHERE firm_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE, created_at`)
    .bind(c.get("firm").id)
    .all();
  return c.json(results);
});

clients.post("/clients", async (c) => {
  const body = await readBody(c);
  if (!body) return invalid(c);
  const name = text(body.name, 200);
  const email = blank(body.email) ? null : normalizeEmail(body.email);
  const tel = phone(body.phone);
  const lang = body.locale === undefined ? "en" : locale(body.locale);
  if (!name || (email === null && !blank(body.email)) || tel === undefined || !lang || typeof body.contact_ok !== "boolean") {
    return invalid(c);
  }
  const userId = c.get("session")!.userId;
  const now = Date.now();
  const id = randomId();
  const db = c.get("db");
  const granted = [email && "email", tel && "sms"].filter(Boolean);
  await db.batch([
    db
      .prepare(
        `INSERT INTO clients (id, firm_id, name, email, phone, locale, email_ok_at, sms_ok_at, consent_by, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        c.get("firm").id,
        name,
        email,
        tel,
        lang,
        body.contact_ok && email ? now : null,
        body.contact_ok && tel ? now : null,
        body.contact_ok ? userId : null,
        userId,
        now,
      ),
    audit(c, "client.create", "client", id),
    ...(body.contact_ok && granted.length ? [audit(c, "client.consent", "client", id, { set: granted })] : []),
  ]);
  const row = await db.prepare(`SELECT ${COLS} FROM clients WHERE id = ?`).bind(id).first();
  return c.json(row, 201);
});

clients.patch("/clients/:id", async (c) => {
  const body = await readBody(c);
  if (!body) return invalid(c);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const row = await db
    .prepare("SELECT id, email, phone, email_ok_at, sms_ok_at FROM clients WHERE firm_id = ? AND id = ? AND deleted_at IS NULL")
    .bind(firmId, c.req.param("id"))
    .first<ClientRow>();
  if (!row) return notFound(c);

  const fields: Record<string, string | number | null> = {};
  if ("name" in body) {
    const name = text(body.name, 200);
    if (!name) return invalid(c);
    fields.name = name;
  }
  if ("email" in body) {
    const email = blank(body.email) ? null : normalizeEmail(body.email);
    if (email === null && !blank(body.email)) return invalid(c);
    fields.email = email;
  }
  if ("phone" in body) {
    const tel = phone(body.phone);
    if (tel === undefined) return invalid(c);
    fields.phone = tel;
  }
  if ("locale" in body) {
    const lang = locale(body.locale);
    if (!lang) return invalid(c);
    fields.locale = lang;
  }
  if ("contact_ok" in body && typeof body.contact_ok !== "boolean") return invalid(c);

  // a changed address or number has not been attested yet
  const email = "email" in fields ? (fields.email as string | null) : row.email;
  const tel = "phone" in fields ? (fields.phone as string | null) : row.phone;
  const now = Date.now();
  if (body.contact_ok !== undefined) {
    fields.email_ok_at = body.contact_ok && email ? now : null;
    fields.sms_ok_at = body.contact_ok && tel ? now : null;
    fields.consent_by = body.contact_ok ? c.get("session")!.userId : null;
  } else {
    if (email !== row.email) fields.email_ok_at = null;
    if (tel !== row.phone) fields.sms_ok_at = null;
  }
  if (!Object.keys(fields).length) return invalid(c);
  const set = setClause(fields);
  const consent = {
    set: CHANNELS.filter(([col]) => fields[col]).map(([, name]) => name),
    cleared: CHANNELS.filter(([col]) => fields[col] === null && row[col]).map(([, name]) => name),
  };
  await db.batch([
    db.prepare(`UPDATE clients SET ${set.sql} WHERE firm_id = ? AND id = ?`).bind(...set.values, firmId, row.id),
    audit(c, "client.update", "client", row.id, { fields: Object.keys(fields) }),
    ...(consent.set.length || consent.cleared.length ? [audit(c, "client.consent", "client", row.id, consent)] : []),
  ]);
  return c.json(await db.prepare(`SELECT ${COLS} FROM clients WHERE id = ?`).bind(row.id).first());
});

clients.delete("/clients/:id", async (c) => {
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const id = c.req.param("id");
  const now = Date.now();
  const found = await db.prepare("SELECT id FROM clients WHERE firm_id = ? AND id = ? AND deleted_at IS NULL").bind(firmId, id).first();
  if (!found) return notFound(c);
  const held = "NOT EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND client_id = ? AND hold_at IS NOT NULL AND deleted_at IS NULL)";
  // the guard is repeated in each write so a hold set after the read still wins
  const [, , res] = await db.batch([
    db
      .prepare(
        `UPDATE links SET revoked_at = ? WHERE firm_id = ? AND revoked_at IS NULL AND ${held}
         AND request_id IN (SELECT id FROM requests WHERE firm_id = ? AND client_id = ?)`,
      )
      .bind(now, firmId, firmId, id, firmId, id),
    db
      .prepare(`UPDATE requests SET status = 'closed', closed_at = ?, ${endNow} WHERE firm_id = ? AND client_id = ? AND status IN ('draft', 'open') AND ${held}`)
      .bind(now, now, now, firmId, id, firmId, id),
    db.prepare(`UPDATE clients SET deleted_at = ? WHERE firm_id = ? AND id = ? AND deleted_at IS NULL AND ${held}`).bind(now, firmId, id, firmId, id),
    audit(c, "client.delete", "client", id, undefined, {
      sql: "EXISTS (SELECT 1 FROM clients WHERE firm_id = ? AND id = ? AND deleted_at = ?)",
      binds: [firmId, id, now],
    }),
  ]);
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: "legal_hold" }, 409);
});
