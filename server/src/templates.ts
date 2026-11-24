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
import { randomId } from "./util";
import { exampleGone, invalid, locale, maybe, notFound, readBody, setClause, text } from "./validate";

const MAX_TEMPLATES = 200;

export type { Item };
type Template = { id: string; name: string; items: Item[] };

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

const MAX_ITEMS = 100;
const COLS = "id, name, locale, items_json, created_at, updated_at";

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
  return { label, ...(help ? { help } : {}), required: o.required ?? true, ...kind, ...(example ? { example } : {}), ...tags };
}

export function parseItems(v: unknown): Item[] | undefined {
  if (!Array.isArray(v) || !v.length || v.length > MAX_ITEMS) return undefined;
  const items = v.map(parseItem);
  return items.every((i) => i) && checkConditions(items as Item[]) ? (items as Item[]) : undefined;
}

type Row = { id: string; name: string; locale: string; items_json: string; created_at: number; updated_at: number };

const present = ({ items_json, ...t }: Row) => ({ ...t, builtin: false, items: JSON.parse(items_json) as Item[] });

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
  const id = randomId();
  const now = Date.now();
  const db = c.get("db");
  const firmId = c.get("firm").id;
  if (!(await ownsExamples(db, firmId, items.map((i) => i.example)))) return exampleGone(c);
  const [res] = await db.batch([
    db
      .prepare(
        `INSERT INTO templates (id, firm_id, name, locale, items_json, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM templates WHERE firm_id = ?) < ${MAX_TEMPLATES}`,
      )
      .bind(id, firmId, name, lang, JSON.stringify(items), now, now, firmId),
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
