import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { audit } from "./audit";
import { endSubscription } from "./billing";
import { isOwner } from "./firm";
import { emptyPrefix, purgeRequest, reasonOf } from "./purge";
import { regionIds, regionOf, type Region } from "./regions";
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
  if (!firm.closed_at && firm.stripe_subscription_id) {
    // first, so a failure here leaves the account open instead of closed and still billed
    try {
      await endSubscription(c.env, firm.stripe_subscription_id);
    } catch (e) {
      log(e);
      return c.json({ error: "billing" }, 502);
    }
  }
  // links go dark with revoked_at = closed_at, which is how a reopen finds the ones to bring back; they go before the
  // account is marked closed, so a failure leaves an open account with dead links, which a retry can finish
  await db.batch([
    db.prepare("INSERT INTO firm_settings (firm_id, closed_at) VALUES (?, ?) ON CONFLICT (firm_id) DO UPDATE SET closed_at = excluded.closed_at").bind(firm.id, at),
    db.prepare("UPDATE links SET revoked_at = ? WHERE firm_id = ? AND revoked_at IS NULL").bind(at, firm.id),
    // sends that have not gone out stay unsent, even if the account comes back
    db.prepare("UPDATE batches SET status = 'cancelled', finished_at = ? WHERE firm_id = ? AND status IN ('scheduled', 'sending')").bind(at, firm.id),
    db.prepare("UPDATE batch_items SET state = 'cancelled' WHERE firm_id = ? AND state = 'pending'").bind(firm.id),
    ...(firm.closed_at ? [] : [audit(c, "account.close", "firm", firm.id)]),
  ]);
  await c.env.CONTROL.prepare(
    `UPDATE firms SET closed_at = ?, cancel_at_period_end = 0,
       plan_status = CASE WHEN stripe_subscription_id IS NOT NULL THEN 'canceled' ELSE plan_status END
     WHERE id = ? AND closed_at IS NULL`,
  )
    .bind(at, firm.id)
    .run();
  await c.env.CONTROL.prepare("DELETE FROM sessions WHERE firm_id = ?").bind(firm.id).run();
  deleteCookie(c, "__Host-lc_session", { path: "/", secure: true });
  return c.json({ ok: true });
});

account.post("/account/reopen", async (c) => {
  if (!(await isOwner(c))) return c.json({ error: "forbidden" }, 403);
  const firm = c.get("firm");
  if (!firm.closed_at) return c.json({ error: "not_closed" }, 409);
  const now = Date.now();
  const db = c.get("db");
  // past the window only an account whose held records are still there can come back; without them nothing is left to reopen
  const expired = firm.closed_at <= now - CLOSE_WINDOW;
  const held = (await db.prepare("SELECT 1 FROM requests WHERE firm_id = ? AND hold_at IS NOT NULL AND deleted_at IS NULL").bind(firm.id).first()) ? 1 : 0;
  if (expired && !held) return c.json({ error: "expired" }, 409);
  // links first: it can be repeated, while a failure after the account is open again could not be retried
  await db.batch([
    db.prepare("UPDATE links SET revoked_at = NULL WHERE firm_id = ? AND revoked_at = ?").bind(firm.id, firm.closed_at),
    db.prepare("UPDATE firm_settings SET closed_at = NULL WHERE firm_id = ?").bind(firm.id),
    audit(c, "account.reopen", "firm", firm.id),
  ]);
  // the purge takes over once the window is up, so it is checked in the same statement that reopens
  const done = await c.env.CONTROL.prepare("UPDATE firms SET closed_at = NULL WHERE id = ? AND closed_at = ? AND (closed_at > ? OR ? = 1)")
    .bind(firm.id, firm.closed_at, now - CLOSE_WINDOW, held)
    .run();
  if (!done.meta.changes) return c.json({ error: "expired" }, 409);
  return c.json({ ok: true });
});

const missing = (e: unknown) => e instanceof StripeError && e.status === 404;

// Anything still billing the customer stops, then the customer goes, so no name or email is left at Stripe.
async function dropCustomer(env: Env, customer: string) {
  const subs = await stripe<{ data: { id: string; status: string }[] }>(env, "GET", "/v1/subscriptions", { customer, status: "all", limit: 10 }).catch((e) => {
    if (missing(e)) return null;
    throw e;
  });
  if (!subs) return;
  for (const s of subs.data) {
    if (s.status !== "canceled" && s.status !== "incomplete_expired") await stripe(env, "DELETE", `/v1/subscriptions/${encodeURIComponent(s.id)}`);
  }
  await stripe(env, "DELETE", `/v1/customers/${encodeURIComponent(customer)}`).catch((e) => {
    if (!missing(e)) throw e;
  });
}

type Req = { id: string; firm_id: string; deleted_reason: string | null; deleted_with_account: number };

// Requests go through the usual purge, so objects and rows leave in the same order and the same logs are written. The account's
// own rows and key go last, so a run that stops halfway is finished by the next one.
async function purgeFirm(env: Env, id: string, regionId: string, now: number) {
  // a reopen can land between the cron's query and here
  const row = await env.CONTROL.prepare("SELECT stripe_customer_id FROM firms WHERE id = ? AND closed_at IS NOT NULL AND closed_at <= ?")
    .bind(id, now - CLOSE_WINDOW)
    .first<{ stripe_customer_id: string | null }>();
  if (!row) return;
  // tried first, so a firm that can't finish (held requests) goes to the back of the line
  await env.CONTROL.prepare("UPDATE firms SET purge_tried_at = ? WHERE id = ?").bind(now, id).run();
  const { db, bucket } = regionOf(env, regionId as Region);
  await db.prepare("UPDATE requests SET deleted_at = ?, deleted_with_account = 1 WHERE firm_id = ? AND deleted_at IS NULL AND hold_at IS NULL").bind(now, id).run();
  const { results } = await db
    .prepare(
      `SELECT id, firm_id, deleted_reason, deleted_with_account FROM requests WHERE firm_id = ? AND hold_at IS NULL AND (purging_at IS NULL OR purging_at < ?)
       AND (purge_failed_at IS NULL OR purge_failed_at < ?) ORDER BY COALESCE(purge_failed_at, 0), created_at LIMIT ?`,
    )
    .bind(id, now - HOUR, now - HOUR, BUDGET)
    .all<Req>();
  for (const req of results) await purgeRequest(db, bucket, req, reasonOf(req), now, now).catch(log);

  const left = await db.prepare("SELECT COUNT(*) AS n FROM requests WHERE firm_id = ?").bind(id).first<{ n: number }>();

  // Requests on legal hold keep their clients, files, audit trail, key and the users who can reopen the account. Everything
  // else goes now, whether or not a hold is left, so a hold doesn't keep the rest of the account's data alive. Stops on
  // addresses stay until the account is gone, so a reopened account still honours them.
  if (row.stripe_customer_id) {
    await dropCustomer(env, row.stripe_customer_id);
    await env.CONTROL.prepare("UPDATE firms SET stripe_customer_id = NULL WHERE id = ?").bind(id).run();
  }
  await env.CONTROL.prepare("DELETE FROM invites WHERE firm_id = ?").bind(id).run();
  await db.batch([
    db.prepare("DELETE FROM staff_mail WHERE firm_id = ?").bind(id),
    db.prepare("DELETE FROM batches WHERE firm_id = ?").bind(id),
    db.prepare("DELETE FROM templates WHERE firm_id = ?").bind(id),
    db.prepare("DELETE FROM clients WHERE firm_id = ? AND NOT EXISTS (SELECT 1 FROM requests WHERE firm_id = clients.firm_id AND client_id = clients.id)").bind(id),
  ]);
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
    db.prepare("DELETE FROM examples WHERE firm_id = ?").bind(id),
    db.prepare("DELETE FROM clients WHERE firm_id = ?").bind(id),
    db.prepare("DELETE FROM firm_settings WHERE firm_id = ?").bind(id),
    db.prepare("DELETE FROM email_stops WHERE firm_id = ?").bind(id),
  ]);
  // the wrapped key goes with the firm row, which is what makes anything left in the bucket unreadable
  await env.CONTROL.batch([
    env.CONTROL.prepare("DELETE FROM login_codes WHERE email IN (SELECT email FROM users WHERE firm_id = ?)").bind(id),
    env.CONTROL.prepare("DELETE FROM sessions WHERE firm_id = ?1 OR user_id IN (SELECT id FROM users WHERE firm_id = ?1)").bind(id),
    ...["passkeys", "pending_logins", "passkey_challenges"].map((t) =>
      env.CONTROL.prepare(`DELETE FROM ${t} WHERE user_id IN (SELECT id FROM users WHERE firm_id = ?)`).bind(id),
    ),
    env.CONTROL.prepare("DELETE FROM users WHERE firm_id = ?").bind(id),
    env.CONTROL.prepare("DELETE FROM firms WHERE id = ?").bind(id),
  ]);
}

export async function purgeClosed(env: Env, now = Date.now()) {
  const due = "closed_at IS NOT NULL AND closed_at <= ?";
  const known = JSON.stringify(regionIds);
  // a region this build doesn't know would take a slot every run and never finish
  const unknown = await env.CONTROL.prepare(`SELECT id, region FROM firms WHERE ${due} AND region NOT IN (SELECT value FROM json_each(?)) LIMIT 5`)
    .bind(now - CLOSE_WINDOW, known)
    .all<{ id: string; region: string }>();
  for (const f of unknown.results) console.error(`closed firm ${f.id} has unknown region ${f.region}`);
  const { results } = await env.CONTROL.prepare(`SELECT id, region FROM firms WHERE ${due} AND region IN (SELECT value FROM json_each(?)) ORDER BY COALESCE(purge_tried_at, 0), closed_at LIMIT ?`)
    .bind(now - CLOSE_WINDOW, known, FIRMS)
    .all<{ id: string; region: string }>();
  for (const f of results) await purgeFirm(env, f.id, f.region, now).catch(log);
}
