import { UnknownYear, restate, validYear } from "./taxyear";
import { factsOf } from "./templates";

// What a new request made from an older one needs so that its checklist is for the next tax year: the year itself, and the
// original wording of each item filled in again. "unknown" when the next year's dates are not known yet.
export async function yearOn(db: D1Database, firmId: string, pairs: { id: string; src: string }[]): Promise<D1PreparedStatement[] | "unknown"> {
  const { results } = await db
    .prepare("SELECT id, tax_year, template_ref FROM requests WHERE firm_id = ? AND tax_year IS NOT NULL AND id IN (SELECT value FROM json_each(?))")
    .bind(firmId, JSON.stringify(pairs.map((p) => p.src)))
    .all<{ id: string; tax_year: number; template_ref: string | null }>();
  const groups = new Map<string, { year: number; ref: string | null; srcs: string[] }>();
  for (const r of results) {
    const key = `${r.tax_year}|${r.template_ref}`;
    groups.set(key, groups.get(key) ?? { year: r.tax_year, ref: r.template_ref, srcs: [] });
    groups.get(key)!.srcs.push(r.id);
  }
  const out: D1PreparedStatement[] = [];
  for (const { year, ref, srcs } of groups.values()) {
    const next = year + 1;
    if (!validYear(next)) return "unknown";
    const facts = await factsOf(db, firmId, ref);
    const made = JSON.stringify(pairs.filter((p) => srcs.includes(p.src)).map((p) => p.id));
    const { results: tpls } = await db
      .prepare("SELECT DISTINCT tpl_json FROM items WHERE firm_id = ? AND tpl_json IS NOT NULL AND request_id IN (SELECT value FROM json_each(?))")
      .bind(firmId, JSON.stringify(srcs))
      .all<{ tpl_json: string }>();
    out.push(db.prepare("UPDATE requests SET tax_year = ?, template_ref = ? WHERE firm_id = ? AND id IN (SELECT value FROM json_each(?))").bind(next, ref, firmId, made));
    for (const { tpl_json } of tpls) {
      try {
        const { label, help } = restate(tpl_json, next, facts);
        out.push(
          db
            .prepare("UPDATE items SET label = ?, help = ? WHERE firm_id = ? AND tpl_json = ? AND request_id IN (SELECT value FROM json_each(?))")
            .bind(label, help, firmId, tpl_json, made),
        );
      } catch (e) {
        if (e instanceof UnknownYear) return "unknown";
        throw e;
      }
    }
  }
  return out;
}
