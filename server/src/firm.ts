import { Hono, type MiddlewareHandler } from "hono";
import { audit } from "./audit";
import { isRegion, regionOf } from "./regions";
import type { AppEnv, Firm } from "./session";
import { invalid, maybe, readBody, setClause, text } from "./validate";

export const firm = new Hono<AppEnv>();

const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];

export function usable(f: Firm, now: number): boolean {
  return f.plan_status === "active" || (f.plan_status === "trialing" && f.trial_ends_at !== null && f.trial_ends_at > now);
}

export const loadFirm: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const row = await c.env.CONTROL.prepare(
    "SELECT id, name, legal_name, address, phone, province, region, plan_status, trial_ends_at FROM firms WHERE id = ?",
  )
    .bind(session.firmId)
    .first<Firm>();
  if (!row || !isRegion(row.region)) return c.json({ error: "unauthorized" }, 401);
  c.set("firm", row);
  c.set("db", regionOf(c.env, row.region).db);
  await next();
};

firm.get("/firm", (c) => {
  const { region: _region, ...profile } = c.get("firm");
  return c.json(profile);
});

firm.patch("/firm", async (c) => {
  const user = await c.env.CONTROL.prepare("SELECT role FROM users WHERE id = ?")
    .bind(c.get("session")!.userId)
    .first<{ role: string }>();
  if (user?.role !== "owner") return c.json({ error: "forbidden" }, 403);
  const body = await readBody(c);
  if (!body) return invalid(c);
  const fields: Record<string, string | null> = {};
  if ("name" in body) {
    const name = text(body.name, 120);
    if (!name) return invalid(c);
    fields.name = name;
  }
  for (const [key, max] of [["legal_name", 160], ["address", 300], ["phone", 40]] as const) {
    if (!(key in body)) continue;
    const v = maybe(body[key], max);
    if (v === undefined) return invalid(c);
    fields[key] = v;
  }
  if ("province" in body) {
    const p = body.province === null || body.province === "" ? null : body.province;
    if (p !== null && !PROVINCES.includes(p as string)) return invalid(c);
    fields.province = p as string | null;
  }
  if (!Object.keys(fields).length) return invalid(c);
  const set = setClause(fields);
  await c.env.CONTROL.prepare(`UPDATE firms SET ${set.sql} WHERE id = ?`)
    .bind(...set.values, c.get("firm").id)
    .run();
  // the audit table lives in the region database, so this can't share a batch with the update above
  await audit(c, "firm.update", "firm", c.get("firm").id, { fields: Object.keys(fields) }).run();
  return c.json({ ok: true });
});
