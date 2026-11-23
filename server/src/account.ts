import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { audit } from "./audit";
import { isOwner } from "./firm";
import { emptyPrefix, purgeRequest } from "./purge";
import { isRegion, regionOf } from "./regions";
import type { AppEnv } from "./session";
import { StripeError, stripe } from "./stripe";
import { DAY, HOUR, randomId } from "./util";
import { invalid, readBody } from "./validate";

export const account = new Hono<AppEnv>();

// how long a closed account can be reopened before the cron deletes what is left
export const CLOSE_WINDOW = 30 * DAY;

// requests purged per firm per run
const BUDGET = 20;
const FIRMS = 5;

const log = (e: unknown) => console.error(e instanceof Error ? e.message : "error");

account.post("/account/close", async (c) => {
  if (!(await isOwner(c))) return c.json({ error: "forbidden" }, 403);
  const firm = c.get("firm");
  const body = await readBody(c);
  if (typeof body?.confirm !== "string" || body.confirm.trim() !== firm.name) return invalid(c);
  const now = Date.now();
  const db = c.get("db");

  // a retry after a failure further down finds the account closed already and carries on from the stored time
  const at = firm.closed_at ?? now;
  if (!firm.closed_at && firm.stripe_subscription_id && firm.plan_status !== "canceled") {
    // first, so a failure here leaves the account open instead of closed and still billed
    const id = encodeURIComponent(firm.stripe_subscription_id);
    try {
      await stripe(c.env, "DELETE", `/v1/subscriptions/${id}`);
    } catch (e) {
      const ended = await stripe<{ status: string }>(c.env, "GET", `/v1/subscriptions/${id}`).then((s) => s.status === "canceled", () => false);
      if (!ended && !(e instanceof StripeError && e.status === 404)) {
        log(e);
        return c.json({ error: "billing" }, 502);
      }
    }
  }
  await c.env.CONTROL.prepare(
    `UPDATE firms SET closed_at = ?, cancel_at_period_end = 0,
       plan_status = CASE WHEN stripe_subscription_id IS NOT NULL THEN 'canceled' ELSE plan_status END
     WHERE id = ? AND closed_at IS NULL`,
  )
    .bind(at, firm.id)
    .run();
  // links go dark with revoked_at = closed_at, which is how a reopen finds the ones to bring back
  await db.batch([
    db.prepare("UPDATE links SET revoked_at = ? WHERE firm_id = ? AND revoked_at IS NULL").bind(at, firm.id),
    audit(c, "account.close", "firm", firm.id),
  ]);
  await c.env.CONTROL.prepare("DELETE FROM sessions WHERE firm_id = ?").bind(firm.id).run();
  deleteCookie(c, "__Host-lc_session", { path: "/", secure: true });
  return c.json({ ok: true });
});

account.post("/account/reopen", async (c) => {
  if (!(await isOwner(c))) return c.json({ error: "forbidden" }, 403);
  const firm = c.get("firm");
  if (!firm.closed_at) return c.json({ error: "not_closed" }, 409);
  const now = Date.now();
  if (firm.closed_at <= now - CLOSE_WINDOW) return c.json({ error: "expired" }, 409);
  // links first: it can be repeated, while a failure after the account is open again could not be retried
  const db = c.get("db");
  await db.batch([
    db.prepare("UPDATE links SET revoked_at = NULL WHERE firm_id = ? AND revoked_at = ?").bind(firm.id, firm.closed_at),
    audit(c, "account.reopen", "firm", firm.id),
  ]);
  // the purge takes over once the window is up, so it is checked in the same statement that reopens
  const done = await c.env.CONTROL.prepare("UPDATE firms SET closed_at = NULL WHERE id = ? AND closed_at = ? AND closed_at > ?")
    .bind(firm.id, firm.closed_at, now - CLOSE_WINDOW)
    .run();
  if (!done.meta.changes) return c.json({ error: "expired" }, 409);
  return c.json({ ok: true });
});

type Req = { id: string; firm_id: string };

// Requests go through the usual purge, so objects and rows leave in the same order and the same logs are written. The account's
// own rows and key go last, so a run that stops halfway is finished by the next one.
async function purgeFirm(env: Env, id: string, regionId: string, now: number) {
  // tried first, so a firm that can't finish (held requests) goes to the back of the line
  await env.CONTROL.prepare("UPDATE firms SET purge_tried_at = ? WHERE id = ?").bind(now, id).run();
  if (!isRegion(regionId)) return;
  const { db, bucket } = regionOf(env, regionId);
  await db.prepare("UPDATE requests SET deleted_at = ? WHERE firm_id = ? AND deleted_at IS NULL AND hold_at IS NULL").bind(now, id).run();
  const { results } = await db
    .prepare(
      `SELECT id, firm_id FROM requests WHERE firm_id = ? AND hold_at IS NULL AND (purging_at IS NULL OR purging_at < ?)
       AND (purge_failed_at IS NULL OR purge_failed_at < ?) ORDER BY COALESCE(purge_failed_at, 0), created_at LIMIT ?`,
    )
    .bind(id, now - HOUR, now - HOUR, BUDGET)
    .all<Req>();
  for (const req of results) await purgeRequest(db, bucket, req, "closed", now, now).catch(log);

  const left = await db.prepare("SELECT COUNT(*) AS n FROM requests WHERE firm_id = ?").bind(id).first<{ n: number }>();
  // TODO: requests on legal hold are kept, and with them the clients, key and users they need. A person has to release
  // them or hand the records over before the rest of the account can go.
  if (left!.n > 0) return;

  await emptyPrefix(bucket, `f/${id}/`);
  await db.batch([
    db
      .prepare(
        `INSERT INTO deletion_log (id, firm_id, kind, target_id, reason, files, at)
         SELECT ?, ?, 'firm', ?, 'closed', (SELECT COALESCE(SUM(files), 0) FROM deletion_log WHERE firm_id = ? AND kind = 'request' AND reason = 'closed'), ?
         WHERE NOT EXISTS (SELECT 1 FROM deletion_log WHERE firm_id = ? AND kind = 'firm')`,
      )
      .bind(randomId(), id, id, id, now, id),
    db.prepare("DELETE FROM audit WHERE firm_id = ?").bind(id),
    db.prepare("DELETE FROM clients WHERE firm_id = ?").bind(id),
    db.prepare("DELETE FROM templates WHERE firm_id = ?").bind(id),
    db.prepare("DELETE FROM firm_settings WHERE firm_id = ?").bind(id),
  ]);
  // the wrapped key goes with the firm row, which is what makes anything left in the bucket unreadable
  await env.CONTROL.batch([
    env.CONTROL.prepare("DELETE FROM login_codes WHERE email IN (SELECT email FROM users WHERE firm_id = ?)").bind(id),
    env.CONTROL.prepare("DELETE FROM sessions WHERE firm_id = ?").bind(id),
    env.CONTROL.prepare("DELETE FROM users WHERE firm_id = ?").bind(id),
    env.CONTROL.prepare("DELETE FROM firms WHERE id = ?").bind(id),
  ]);
}

export async function purgeClosed(env: Env, now = Date.now()) {
  const { results } = await env.CONTROL.prepare("SELECT id, region FROM firms WHERE closed_at IS NOT NULL AND closed_at <= ? ORDER BY COALESCE(purge_tried_at, 0), closed_at LIMIT ?")
    .bind(now - CLOSE_WINDOW, FIRMS)
    .all<{ id: string; region: string }>();
  for (const f of results) await purgeFirm(env, f.id, f.region, now).catch(log);
}
