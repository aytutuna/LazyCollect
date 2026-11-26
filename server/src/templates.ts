import { Hono } from "hono";
import ircCitizenship from "../templates/ircc-citizenship";
import ircExpressEntry from "../templates/ircc-express-entry";
import ircPgwp from "../templates/ircc-pgwp";
import ircSpousal from "../templates/ircc-spousal-sponsorship";
import ircStudy from "../templates/ircc-study-permit";
import ircVisitor from "../templates/ircc-visitor-visa";
import ircWork from "../templates/ircc-work-permit";
import ircWorkExtension from "../templates/ircc-work-permit-extension";
import bookkeeping from "../templates/bookkeeping-month-end";
import onboarding from "../templates/client-onboarding";
import gstHst from "../templates/gst-hst-return";
import t1Personal from "../templates/t1-personal";
import t1SelfEmployed from "../templates/t1-self-employed.json";
import t2YearEnd from "../templates/t2-year-end";
import { builtinTemplatesFr } from "../templates/fr";
import { audit } from "./audit";
import { isLang, langOf, type Lang } from "./lang";
import type { AppEnv } from "./session";
import { ownsExamples, parseExample } from "./examples";
import { parseKind, parseTags, checkConditions, type Item } from "./questions";
import { markedChoice, tax, type Facts } from "./taxyear";
import { randomId } from "./util";
import { exampleGone, invalid, locale, maybe, notFound, readBody, setClause, text } from "./validate";

const MAX_TEMPLATES = 200;

export type { Item };
type Template = { id: string; name: string; items: Item[]; facts?: Facts };

export const builtinTemplates: Template[] = [
  t1Personal,
  t1SelfEmployed,
  t2YearEnd,
  bookkeeping,
  gstHst,
  onboarding,
  ircExpressEntry,
  ircSpousal,
  ircStudy,
  ircPgwp,
  ircWork,
  ircWorkExtension,
  ircVisitor,
  ircCitizenship,
];

// the built-in templates in the language of the request they will start
export const builtinsFor = (lang: Lang) => (lang === "fr-CA" ? builtinTemplatesFr : builtinTemplates);

// the facts a request's checklist fills in: a built-in's own, or the copy an account made of one
export async function factsOf(db: D1Database, firmId: string, ref: string | null | undefined): Promise<Facts> {
  if (!ref) return {};
  const built = builtinTemplates.find((t) => t.id === ref);
  if (built) return built.facts ?? {};
  const row = await db.prepare("SELECT facts_json FROM templates WHERE firm_id = ? AND id = ?").bind(firmId, ref).first<{ facts_json: string | null }>();
  if (row) return row.facts_json ? JSON.parse(row.facts_json) : {};
  // the account's copy is gone: the built-in checklists' facts stand in, so what came from it can still be repeated
  const merged: Facts = {};
  for (const t of builtinTemplates) for (const [year, f] of Object.entries(t.facts ?? {})) merged[Number(year)] = { ...merged[Number(year)], ...f };
  return merged;
}

const MAX_ITEMS = 100;
const COLS = "id, name, locale, items_json, source_id, facts_json, created_at, updated_at";

export function parseItem(v: unknown): Item | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const label = text(o.label, 200);
  const help = maybe(o.help, 500);
  if (!label || help === undefined || (o.required !== undefined && typeof o.required !== "boolean")) return undefined;
  const kind = parseKind(o);
  const example = parseExample(o.example);
  const tags = kind && parseTags(o, kind.kind ?? "file", Boolean(kind.show_if));
  if (!kind || !tags || example === undefined) return undefined;
  const item: Item = { label, ...(help ? { help } : {}), required: o.required ?? true, ...kind, ...(example ? { example } : {}), ...tags };
  return markedChoice(item) ? undefined : item;
}

export function parseItems(v: unknown): Item[] | undefined {
  if (!Array.isArray(v) || !v.length || v.length > MAX_ITEMS) return undefined;
  const items = v.map(parseItem);
  return items.every((i) => i) && checkConditions(items as Item[]) ? (items as Item[]) : undefined;
}

type Row = { id: string; name: string; locale: string; items_json: string; source_id: string | null; facts_json: string | null; created_at: number; updated_at: number };

// "newer" when the built-in a copy came from has facts the copy does not
const present = ({ items_json, facts_json, source_id, ...t }: Row) => {
  const items = JSON.parse(items_json) as Item[];
  const facts: Facts | undefined = facts_json ? JSON.parse(facts_json) : undefined;
  const built = source_id ? builtinTemplates.find((b) => b.id === source_id) : undefined;
  return { ...t, builtin: false, items, tax: tax(items, facts), newer: Boolean(built?.facts && JSON.stringify(built.facts) !== facts_json) };
};

export const templates = new Hono<AppEnv>();

templates.get("/templates", async (c) => {
  const { results } = await c.get("db")
    .prepare(`SELECT ${COLS} FROM templates WHERE firm_id = ? ORDER BY name COLLATE NOCASE`)
    .bind(c.get("firm").id)
    .all<Row>();
  const q = c.req.query("locale");
  const lang = isLang(q) ? q : langOf(c);
  return c.json([...builtinsFor(lang).map((t) => ({ ...t, locale: lang, builtin: true })), ...results.map(present)]);
});

templates.post("/templates", async (c) => {
  const body = await readBody(c);
  if (!body) return invalid(c);
  const name = text(body.name, 120);
  const lang = body.locale === undefined ? "en" : locale(body.locale);
  const items = parseItems(body.items);
  if (!name || !lang || !items) return invalid(c);
  // a copy of a built-in keeps its facts, so its dates and rules stay as they were until the account takes newer ones
  const source = typeof body.source === "string" ? builtinTemplates.find((t) => t.id === body.source) : undefined;
  const id = randomId();
  const now = Date.now();
  const db = c.get("db");
  const firmId = c.get("firm").id;
  if (!(await ownsExamples(db, firmId, items.map((i) => i.example)))) return exampleGone(c);
  const [res] = await db.batch([
    db
      .prepare(
        `INSERT INTO templates (id, firm_id, name, locale, items_json, source_id, facts_json, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM templates WHERE firm_id = ?) < ${MAX_TEMPLATES}`,
      )
      .bind(id, firmId, name, lang, JSON.stringify(items), source?.facts ? source.id : null, source?.facts ? JSON.stringify(source.facts) : null, now, now, firmId),
    audit(c, "template.create", "template", id, undefined, { sql: "EXISTS (SELECT 1 FROM templates WHERE firm_id = ? AND id = ?)", binds: [firmId, id] }),
  ]);
  if (!res.meta.changes) return c.json({ error: "too_many_templates" }, 409);
  const row = await db.prepare(`SELECT ${COLS} FROM templates WHERE id = ?`).bind(id).first<Row>();
  return c.json(present(row!), 201);
});

templates.patch("/templates/:id", async (c) => {
  const body = await readBody(c);
  if (!body) return invalid(c);
  const fields: Record<string, string | number | null> = {};
  if ("name" in body) {
    const name = text(body.name, 120);
    if (!name) return invalid(c);
    fields.name = name;
  }
  if ("locale" in body) {
    const lang = locale(body.locale);
    if (!lang) return invalid(c);
    fields.locale = lang;
  }
  if ("items" in body) {
    const items = parseItems(body.items);
    if (!items) return invalid(c);
    if (!(await ownsExamples(c.get("db"), c.get("firm").id, items.map((i) => i.example)))) return exampleGone(c);
    fields.items_json = JSON.stringify(items);
  }
  if (!Object.keys(fields).length) return invalid(c);
  fields.updated_at = Date.now();
  const set = setClause(fields);
  const db = c.get("db");
  const found = await db.prepare("SELECT id FROM templates WHERE firm_id = ? AND id = ?").bind(c.get("firm").id, c.req.param("id")).first();
  if (!found) return notFound(c);
  await db.batch([
    db
      .prepare(`UPDATE templates SET ${set.sql} WHERE firm_id = ? AND id = ?`)
      .bind(...set.values, c.get("firm").id, c.req.param("id")),
    audit(c, "template.update", "template", c.req.param("id")),
  ]);
  const row = await db.prepare(`SELECT ${COLS} FROM templates WHERE id = ?`).bind(c.req.param("id")).first<Row>();
  return c.json(present(row!));
});

// takes the built-in's current dates and rules into a copy made from it
templates.post("/templates/:id/facts", async (c) => {
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const row = await db.prepare(`SELECT ${COLS} FROM templates WHERE firm_id = ? AND id = ?`).bind(firmId, c.req.param("id")).first<Row>();
  if (!row) return notFound(c);
  const built = row.source_id ? builtinTemplates.find((t) => t.id === row.source_id) : undefined;
  if (!built?.facts) return c.json({ error: "no_source" }, 409);
  await db.batch([
    db.prepare("UPDATE templates SET facts_json = ?, updated_at = ? WHERE firm_id = ? AND id = ?").bind(JSON.stringify(built.facts), Date.now(), firmId, row.id),
    audit(c, "template.facts", "template", row.id),
  ]);
  return c.json(present((await db.prepare(`SELECT ${COLS} FROM templates WHERE id = ?`).bind(row.id).first<Row>())!));
});

templates.delete("/templates/:id", async (c) => {
  const db = c.get("db");
  const found = await db.prepare("SELECT id FROM templates WHERE firm_id = ? AND id = ?").bind(c.get("firm").id, c.req.param("id")).first();
  if (!found) return notFound(c);
  await db.batch([
    db.prepare("DELETE FROM templates WHERE firm_id = ? AND id = ?").bind(c.get("firm").id, c.req.param("id")),
    audit(c, "template.delete", "template", c.req.param("id")),
  ]);
  return c.json({ ok: true });
});
