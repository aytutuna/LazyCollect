import { Hono, type Context, type MiddlewareHandler } from "hono";
import { audit } from "./audit";
import { isRegion, regionOf } from "./regions";
import type { AppEnv, Firm } from "./session";
import { validZone } from "./tz";
import { DAY, keyLimited } from "./util";
import { invalid, maybe, readBody, setClause, text } from "./validate";

export const firm = new Hono<AppEnv>();

const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];

// how long a failed renewal keeps the account working while the card is fixed; counted from the first failure,
// since Stripe has already moved current_period_end a month ahead by then
export const PAST_DUE_GRACE = 7 * DAY;

export function usable(f: Pick<Firm, "plan_status" | "trial_ends_at" | "past_due_since" | "closed_at">, now: number): boolean {
  if (f.closed_at) return false;
  switch (f.plan_status) {
    case "active":
      return true;
    case "trialing":
      return f.trial_ends_at !== null && f.trial_ends_at > now;
    case "past_due":
      return f.past_due_since !== null && now < f.past_due_since + PAST_DUE_GRACE;
    default:
      return false;
  }
}

function load(allowClosed: boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const row = await c.env.CONTROL.prepare(
      `SELECT id, name, legal_name, address, phone, province, tz, region, plan_status, trial_ends_at, current_period_end, past_due_since,
         cancel_at_period_end, stripe_customer_id, stripe_subscription_id, closed_at FROM firms WHERE id = ?`,
    )
      .bind(session.firmId)
      .first<Firm>();
    if (!row || !isRegion(row.region)) return c.json({ error: "unauthorized" }, 401);
    if (row.closed_at && !allowClosed) return c.json({ error: "closed" }, 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && (await keyLimited(c.env.FIRM_WRITE, row.id))) return c.json({ error: "rate_limited" }, 429);
    c.set("firm", row);
    c.set("db", regionOf(c.env, row.region).db);
    await next();
  };
}

export const loadFirm = load(false);
export const loadClosedFirm = load(true);

firm.get("/firm", (c) => {
  const { region: _region, stripe_customer_id: _customer, stripe_subscription_id: _subscription, ...profile } = c.get("firm");
  return c.json(profile);
});

export async function isOwner(c: Context<AppEnv>): Promise<boolean> {
  const user = await c.env.CONTROL.prepare("SELECT role FROM users WHERE id = ?")
    .bind(c.get("session")!.userId)
    .first<{ role: string }>();
  return user?.role === "owner";
}

firm.patch("/firm", async (c) => {
  if (!(await isOwner(c))) return c.json({ error: "forbidden" }, 403);
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
  if ("tz" in body) {
    if (typeof body.tz !== "string" || !validZone(body.tz)) return invalid(c);
    fields.tz = body.tz;
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
