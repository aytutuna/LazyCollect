import { Hono } from "hono";
import { normalizeEmail } from "./auth";
import { usable } from "./firm";
import type { AppEnv } from "./session";
import { blank, invalid, maybe, readBody, text } from "./validate";
import { MAX_CLIENTS, phone } from "./clients";

export const importer = new Hono<AppEnv>();

export const IMPORT_CHUNK = 200;

type Found = { id: string; name: string; email: string | null; phone: string | null; reference: string | null; email_ok_at: number | null; sms_ok_at: number | null; consent_by: string | null };
type Clean = { name: string; email: string | null; phone: string | null; reference: string | null };
type Result = { status: "new" | "update" | "skip"; reason?: string; id?: string };

function clean(raw: unknown): Clean | string {
  if (!raw || typeof raw !== "object") return "no_name";
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 200);
  if (!name) return "no_name";
  const email = blank(r.email) ? null : normalizeEmail(r.email);
  if (email === null && !blank(r.email)) return "bad_email";
  const tel = phone(r.phone);
  if (tel === undefined) return "bad_phone";
  const reference = maybe(r.reference, 100);
  if (reference === undefined) return "bad_reference";
  return { name, email, phone: tel, reference };
}

// the address names a client; without one, the same name does, unless the references say they are different people
// SQLite lower() only folds ASCII, so names are compared here
const fold = (name: string) => name.normalize("NFC").toLowerCase();
const keyOf = (r: Clean) => (r.email ? `e:${r.email}` : `n:${fold(r.name)}|${r.reference ?? ""}`);
const sameClient = (r: Clean, f: Found) =>
  r.email ? f.email?.toLowerCase() === r.email : f.email === null && fold(f.name) === fold(r.name) && (!r.reference || !f.reference || r.reference === f.reference);

// what an existing client would gain: empty fields are filled, nothing is overwritten
function gains(r: Clean, f: Found): boolean {
  const tel = f.phone ?? r.phone;
  return (!f.phone && !!r.phone) || (!f.reference && !!r.reference) || (!!f.email && !f.email_ok_at) || (!!tel && !f.sms_ok_at);
}

importer.post("/clients/import", async (c) => {
  const body = await readBody(c);
  if (!body || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > IMPORT_CHUNK) return invalid(c);
  const dry = body.dry_run === true;
  if (!dry && (body.contact_ok !== true || typeof body.import_id !== "string" || !/^[0-9a-f]{32}$/.test(body.import_id))) return invalid(c);
  const firm = c.get("firm");
  if (!usable(firm, Date.now())) return c.json({ error: "plan" }, 402);
  const db = c.get("db");

  const rows = body.rows.map(clean);
  const good = rows.filter((r): r is Clean => typeof r !== "string");
  const emails = good.flatMap((r) => (r.email ? [r.email] : []));
  const names = good.flatMap((r) => (r.email ? [] : [fold(r.name)]));
  const [known, nameless, total] = await db.batch([
    db
      .prepare(
        `SELECT id, name, email, phone, reference, email_ok_at, sms_ok_at, consent_by FROM clients WHERE firm_id = ? AND deleted_at IS NULL
         AND lower(email) IN (SELECT value FROM json_each(?))`,
      )
      .bind(firm.id, JSON.stringify(emails)),
    db
      .prepare(
        `SELECT id, name, email, phone, reference, email_ok_at, sms_ok_at, consent_by FROM clients WHERE firm_id = ? AND deleted_at IS NULL AND email IS NULL AND ? > 0`,
      )
      .bind(firm.id, names.length),
    db.prepare("SELECT COUNT(*) AS n FROM clients WHERE firm_id = ?").bind(firm.id),
  ]);
  const wanted = new Set(names);
  const found = [...(known.results as Found[]), ...(nameless.results as Found[]).filter((f) => wanted.has(fold(f.name)))];
  let room = MAX_CLIENTS - (total.results[0] as { n: number }).n;

  const seen = new Set<string>();
  const adds: Clean[] = [];
  const fills: Found[] = [];
  const fillWith: Clean[] = [];
  const out: Result[] = rows.map((r) => {
    if (typeof r === "string") return { status: "skip", reason: r };
    const key = keyOf(r);
    if (seen.has(key)) return { status: "skip", reason: "duplicate_in_file" };
    seen.add(key);
    const match = found.find((f) => sameClient(r, f));
    if (match) {
      if (!gains(r, match)) return { status: "skip", reason: "nothing_new", id: match.id };
      fills.push(match);
      fillWith.push(r);
      return { status: "update", id: match.id };
    }
    if (room <= 0) return { status: "skip", reason: "client_limit" };
    room--;
    adds.push(r);
    return { status: "new" };
  });

  const counts = { new: adds.length, update: fills.length, skip: out.length - adds.length - fills.length };
  if (dry) return c.json({ rows: out, counts });

  const now = Date.now();
  const userId = c.get("session")!.userId;
  await db.batch([
    db
      .prepare(
        `INSERT INTO clients (id, firm_id, name, email, phone, reference, locale, email_ok_at, sms_ok_at, consent_by, created_by, created_at)
         SELECT lower(hex(randomblob(16))), ?1, json_extract(value, '$.name'), json_extract(value, '$.email'), json_extract(value, '$.phone'), json_extract(value, '$.reference'), 'en',
           CASE WHEN json_extract(value, '$.email') IS NOT NULL THEN ?2 END, CASE WHEN json_extract(value, '$.phone') IS NOT NULL THEN ?2 END,
           CASE WHEN json_extract(value, '$.email') IS NOT NULL OR json_extract(value, '$.phone') IS NOT NULL THEN ?3 END, ?3, ?2
         FROM json_each(?4) WHERE (SELECT COUNT(*) FROM clients WHERE firm_id = ?1) + key < ${MAX_CLIENTS}`,
      )
      .bind(firm.id, now, userId, JSON.stringify(adds)),
    db
      .prepare(
        `UPDATE clients SET phone = COALESCE(clients.phone, j.phone), reference = COALESCE(clients.reference, j.reference),
           email_ok_at = CASE WHEN clients.email IS NOT NULL THEN COALESCE(clients.email_ok_at, ?2) END,
           sms_ok_at = CASE WHEN COALESCE(clients.phone, j.phone) IS NOT NULL THEN COALESCE(clients.sms_ok_at, ?2) END,
           consent_by = CASE WHEN clients.email IS NOT NULL OR COALESCE(clients.phone, j.phone) IS NOT NULL THEN COALESCE(clients.consent_by, ?3) ELSE clients.consent_by END
         FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.phone') AS phone, json_extract(value, '$.reference') AS reference FROM json_each(?4)) j
         WHERE clients.firm_id = ?1 AND clients.id = j.id AND clients.deleted_at IS NULL`,
      )
      .bind(firm.id, now, userId, JSON.stringify(fills.map((f, i) => ({ id: f.id, phone: fillWith[i].phone, reference: fillWith[i].reference })))),
    // one row for the whole import: each chunk adds its counts to it
    db
      .prepare(
        `INSERT INTO audit (id, firm_id, at, actor_type, actor_id, action, object_type, object_id, meta)
         VALUES (?1, ?2, ?3, 'user', ?4, 'client.import', 'import', ?1, ?5)
         ON CONFLICT (id) DO UPDATE SET meta = json_object(
           'new', json_extract(audit.meta, '$.new') + json_extract(excluded.meta, '$.new'),
           'update', json_extract(audit.meta, '$.update') + json_extract(excluded.meta, '$.update'),
           'skip', json_extract(audit.meta, '$.skip') + json_extract(excluded.meta, '$.skip'))
         WHERE audit.firm_id = excluded.firm_id AND audit.action = 'client.import'`,
      )
      .bind(body.import_id, firm.id, now, userId, JSON.stringify(counts)),
  ]);
  return c.json({ rows: out, counts });
});
