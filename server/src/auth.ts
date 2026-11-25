import { Hono, type Context } from "hono";
import { createSession, endSession, holdLogin, type App, type AppEnv } from "./session";
import { sendLoginEmail } from "./email";
import { untouchedRegion, untouchedSql, usable } from "./firm";
import { sendTrialNotice } from "./trial";
import { htmlHeaders } from "./headers";
import { isRegion, regionOf, type Region } from "./regions";
import { DAY, MINUTE, hmac, keyLimited, randomCode, randomId, randomToken, sha256, ipPrefix, FETCH_TIMEOUT_MS } from "./util";

export const auth = new Hono<AppEnv>();

const CODE_TTL = 10 * MINUTE;
const MAX_CODES = 3;
const MAX_ATTEMPTS = 3;
const MAX_FAILED_PER_DAY = 10;
const TRIAL_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function need(env: Env, ...names: (keyof Env)[]) {
  for (const n of names) if (!env[n]) throw new Error(`${n} is not set`);
}

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const email = v.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

async function turnstileOk(env: Env, token: unknown, ip: string | undefined): Promise<boolean> {
  if (typeof token !== "string" || !token) return false;
  const res = await fetch(`${env.TURNSTILE_BASE ?? "https://challenges.cloudflare.com"}/turnstile/v0/siteverify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return false;
  const body = await res.json<{ success?: boolean }>();
  return body.success === true;
}

export async function rateLimited(env: Env, limiter: RateLimit | undefined, ip: string | undefined): Promise<boolean> {
  return keyLimited(limiter, await hmac(env.HASH_KEY, ipPrefix(ip ?? "unknown")));
}

auth.post("/auth/start", async (c) => {
  need(c.env, "TURNSTILE_SECRET", "RESEND_API_KEY", "HASH_KEY");
  const body = await c.req.json<{ email?: unknown; turnstile?: unknown }>().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) return c.json({ error: "invalid_email" }, 400);
  const ip = c.req.header("CF-Connecting-IP");
  if (await rateLimited(c.env, c.env.LOGIN, ip)) return c.json({ error: "rate_limited" }, 429);
  if (!(await turnstileOk(c.env, body?.turnstile, ip))) return c.json({ error: "turnstile" }, 400);
  return sendCode(c, email);
});

// the part of signing in that follows the bot check, shared with the apps
export async function sendCode(c: Context<AppEnv>, email: string, app: App | null = null): Promise<Response> {
  const db = c.env.CONTROL;
  const now = Date.now();
  const id = randomId();
  const emailHash = await hmac(c.env.HASH_KEY, email);
  const code = randomCode();
  const linkToken = randomToken();
  // the count sits inside the insert so parallel requests can't pass the cap together
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO login_codes (id, email, email_hash, code_hash, link_hash, expires_at, created_at, platform)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM login_codes WHERE email_hash = ? AND created_at > ?) < ?`,
      )
      .bind(id, email, emailHash, await hmac(c.env.HASH_KEY, `${emailHash}:${code}`), await sha256(linkToken), now + CODE_TTL, now, app, emailHash, now - CODE_TTL, MAX_CODES),
    db
      .prepare(
        `UPDATE login_codes SET used_at = COALESCE(used_at, ?), link_used_at = COALESCE(link_used_at, ?)
         WHERE email_hash = ? AND id != ? AND (used_at IS NULL OR link_used_at IS NULL)
         AND EXISTS (SELECT 1 FROM login_codes WHERE id = ?)`,
      )
      .bind(now, now, emailHash, id, id),
  ]);
  if (inserted.meta.changes === 0) return c.json({ ok: true });
  try {
    await sendLoginEmail(c.env, email, code, `${c.env.APP_URL}/api/auth/link?t=${linkToken}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "login email failed");
    await db.prepare("DELETE FROM login_codes WHERE id = ?").bind(id).run();
    return c.json({ error: "email" }, 502);
  }
  return c.json({ ok: true });
}

type Found = { id: string; firm_id: string; role: string; disabled_at: number | null };

// The newest live invite for the address puts it in the inviting account as a member. A removed member's row is reused,
// since the email is unique, and so is the row of an owner whose own account was never used.
async function acceptInvite(c: Context<AppEnv>, email: string, existing: Found | null): Promise<void> {
  const db = c.env.CONTROL;
  const now = Date.now();
  const invite = await db
    .prepare(
      `SELECT i.id, i.firm_id, i.name, f.region FROM invites i JOIN firms f ON f.id = i.firm_id
       WHERE i.email = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? AND f.closed_at IS NULL
       ORDER BY i.created_at DESC LIMIT 1`,
    )
    .bind(email, now)
    .first<{ id: string; firm_id: string; name: string | null; region: string }>();
  if (!invite) return;
  const live = "EXISTS (SELECT 1 FROM invites WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL)";
  const joined = "EXISTS (SELECT 1 FROM users WHERE email = ? AND firm_id = ?)";
  const userId = existing?.id ?? randomId();
  // the user row goes first; everything after it only happens if it really is in the inviting account now
  let join: D1PreparedStatement;
  let empty: { region: Region; firmId: string } | null = null;
  if (!existing) {
    join = db
      .prepare(`INSERT INTO users (id, firm_id, email, name, role, created_at) SELECT ?, ?, ?, ?, 'member', ? WHERE ${live} ON CONFLICT (email) DO NOTHING`)
      .bind(userId, invite.firm_id, email, invite.name, now, invite.id);
  } else if (existing.disabled_at) {
    join = db
      .prepare(`UPDATE users SET disabled_at = NULL, firm_id = ?, role = 'member', name = COALESCE(?, name) WHERE id = ? AND disabled_at IS NOT NULL AND ${live}`)
      .bind(invite.firm_id, invite.name, userId, invite.id);
  } else {
    if (existing.role !== "owner" || existing.firm_id === invite.firm_id) return;
    const region = await untouchedRegion(c.env, existing.firm_id, now);
    if (!region) return;
    const u = untouchedSql(existing.firm_id, now);
    // checked again in the update, in case the account was used since the look above
    join = db
      .prepare(`UPDATE users SET firm_id = ?, role = 'member', name = COALESCE(?, name) WHERE id = ? AND firm_id = ? AND role = 'owner' AND disabled_at IS NULL AND ${live} AND ${u.sql}`)
      .bind(invite.firm_id, invite.name, userId, existing.firm_id, invite.id, ...u.binds);
    empty = { region, firmId: existing.firm_id };
  }
  const [, accepted] = await db.batch([
    join,
    db.prepare(`UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND ${joined}`).bind(now, invite.id, email, invite.firm_id),
    // a sign-in that was in flight during the removal may have left a session for the old account
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND ${joined}`).bind(userId, email, invite.firm_id),
    ...(empty
      ? [
          db.prepare("DELETE FROM invites WHERE firm_id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE firm_id = ?)").bind(empty.firmId, empty.firmId),
          db.prepare("DELETE FROM firms WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE firm_id = ?)").bind(empty.firmId, empty.firmId),
        ]
      : []),
  ]);
  if (accepted.meta.changes !== 1) return;
  await regionOf(c.env, invite.region as Region)
    .db.prepare("INSERT INTO audit (id, firm_id, at, actor_type, actor_id, action, object_type, object_id) VALUES (?, ?, ?, 'user', ?, 'invite.accept', 'invite', ?)")
    .bind(randomId(), invite.firm_id, now, userId, invite.id)
    .run();
  if (empty) {
    const gone = regionOf(c.env, empty.region).db;
    await gone.batch([gone.prepare("DELETE FROM firm_settings WHERE firm_id = ?").bind(empty.firmId), gone.prepare("DELETE FROM audit WHERE firm_id = ?").bind(empty.firmId)]);
  }
}

export type SignedIn = { step: "session" | "passkey" | "enrol"; token: string };

// what the email step leads to: a session, or a pending login that owes a passkey (held, or still to be added)
async function signIn(c: Context<AppEnv>, email: string, app: App | null): Promise<SignedIn | null> {
  const db = c.env.CONTROL;
  const find = () => db.prepare("SELECT id, firm_id, role, disabled_at FROM users WHERE email = ?").bind(email).first<Found>();
  let user = await find();
  if (!user || user.disabled_at || user.role === "owner") {
    await acceptInvite(c, email, user);
    user = await find();
  }
  if (!user || user.disabled_at) {
    const now = Date.now();
    const firmId = randomId();
    // A removed member starts a new account on the same row, since the email is unique. A parallel first sign-in may
    // have won the email; then the firm made here is dropped again.
    await db.batch([
      db
        .prepare("INSERT INTO firms (id, plan_status, trial_ends_at, created_at) VALUES (?, 'trialing', ?, ?)")
        .bind(firmId, now + TRIAL_DAYS * DAY, now),
      user
        ? db.prepare("UPDATE users SET firm_id = ?, role = 'owner', disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL").bind(firmId, user.id)
        : db
            .prepare("INSERT INTO users (id, firm_id, email, role, created_at) VALUES (?, ?, ?, 'owner', ?) ON CONFLICT (email) DO NOTHING")
            .bind(randomId(), firmId, email, now),
      // only once the row is in the new firm, so the loser of two parallel sign-ins leaves the winner a session
      db
        .prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?1) AND firm_id != ?2 AND EXISTS (SELECT 1 FROM users WHERE email = ?1 AND firm_id = ?2)")
        .bind(email, firmId),
      db
        .prepare("DELETE FROM firms WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE firm_id = ?)")
        .bind(firmId, firmId),
    ]);
    user = (await find())!;
    if (user.firm_id === firmId) {
      // the account is made and the code was checked; a failed email must not stop the sign-in
      await sendTrialNotice(c.env, { id: firmId, tz: "America/Toronto", trial_ends_at: now + TRIAL_DAYS * DAY }, "start").catch((e) => console.error(e instanceof Error ? e.message : "error"));
    }
  }
  if (user.disabled_at) return null;
  const keys = await db
    .prepare("SELECT (SELECT COUNT(*) FROM passkeys WHERE user_id = ?1) AS keys, (SELECT require_passkeys FROM firms WHERE id = ?2) AS required")
    .bind(user.id, user.firm_id)
    .first<{ keys: number; required: number }>();
  const step = keys!.keys > 0 ? "passkey" : keys!.required === 1 ? "enrol" : null;
  if (step) return { step, token: await holdLogin(c, user.id, step, app) };
  return { step: "session", token: await createSession(c, user.id, user.firm_id, app) };
}

// what a sign-in step answers: the web has its cookies, an app is handed the session token or the pending one
function signedIn(r: SignedIn, app: App | null) {
  if (!app) return r.step === "session" ? { ok: true } : { ok: true, step: r.step };
  return r.step === "session" ? { ok: true, token: r.token } : { ok: true, step: r.step, pending: r.token };
}

auth.post("/auth/verify", (c) => verifyCode(c, null));

export async function verifyCode(c: Context<AppEnv>, app: App | null): Promise<Response> {
  need(c.env, "HASH_KEY");
  if (await rateLimited(c.env, c.env.VERIFY, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  const body = await c.req.json<{ email?: unknown; code?: unknown }>().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email || typeof body?.code !== "string") return c.json({ error: "invalid" }, 400);
  const db = c.env.CONTROL;
  const now = Date.now();
  const emailHash = await hmac(c.env.HASH_KEY, email);
  const failed = await db
    .prepare("SELECT COALESCE(SUM(attempts), 0) AS n FROM login_codes WHERE email_hash = ? AND created_at > ?")
    .bind(emailHash, now - DAY)
    .first<{ n: number }>();
  if (failed!.n >= MAX_FAILED_PER_DAY) return c.json({ error: "too_many" }, 429);
  const row = await db
    .prepare(
      `SELECT id, email, code_hash FROM login_codes
       WHERE email_hash = ? AND platform IS ? AND used_at IS NULL AND expires_at > ? AND attempts < ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(emailHash, app, now, MAX_ATTEMPTS)
    .first<{ id: string; email: string; code_hash: string }>();
  if (!row) return c.json({ error: "invalid" }, 400);
  // count the try before comparing so parallel guesses can't exceed the limit
  const tried = await db
    .prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ?")
    .bind(row.id, MAX_ATTEMPTS)
    .run();
  if (tried.meta.changes !== 1 || (await hmac(c.env.HASH_KEY, `${emailHash}:${body.code.trim()}`)) !== row.code_hash) {
    return c.json({ error: "invalid" }, 400);
  }
  // a correct try isn't a failure for the daily budget
  const used = await db
    .prepare("UPDATE login_codes SET used_at = ?, attempts = attempts - 1 WHERE id = ? AND used_at IS NULL")
    .bind(now, row.id)
    .run();
  if (used.meta.changes !== 1) return c.json({ error: "invalid" }, 400);
  const result = await signIn(c, row.email, app);
  if (!result) return c.json({ error: "disabled" }, 403);
  return c.json(signedIn(result, app));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Mail scanners fetch links with GET or HEAD, so this only looks the token up;
// signing in happens on the POST below.
auth.get("/auth/link", async (c) => {
  const t = c.req.query("t");
  const row = t
    ? await c.env.CONTROL.prepare("SELECT email FROM login_codes WHERE link_hash = ? AND link_used_at IS NULL AND expires_at > ?")
        .bind(await sha256(t), Date.now())
        .first<{ email: string }>()
    : null;
  const page = (body: string) =>
    c.html(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Lazy Collect</title><link rel="stylesheet" href="/link.css"><body>${body}</body>`, row ? 200 : 400, {
      ...htmlHeaders,
      "Cache-Control": "no-store",
    });
  if (!row) return page("<p>This link is invalid or has expired.</p>");
  return page(`<p>Sign in to Lazy Collect as <b>${escapeHtml(row.email)}</b>?</p>
<button id="go">Sign in</button>
<p id="note" role="alert"></p>
<script src="/link.js"></script>`);
});

auth.post("/auth/link", async (c) => {
  need(c.env, "HASH_KEY");
  if (await rateLimited(c.env, c.env.VERIFY, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  const body = await c.req.json<{ t?: unknown }>().catch(() => null);
  if (typeof body?.t !== "string") return c.json({ error: "invalid" }, 400);
  const row = await c.env.CONTROL.prepare(
    "UPDATE login_codes SET link_used_at = ? WHERE link_hash = ? AND link_used_at IS NULL AND expires_at > ? RETURNING email",
  )
    .bind(Date.now(), await sha256(body.t), Date.now())
    .first<{ email: string }>();
  if (!row) return c.json({ error: "invalid" }, 400);
  const result = await signIn(c, row.email, null);
  if (!result) return c.json({ error: "disabled" }, 403);
  return c.json(signedIn(result, null));
});

auth.post("/auth/logout", async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const row = await c.env.CONTROL.prepare(
    `SELECT u.id, u.email, u.name, u.role, f.id AS firm_id, f.name AS firm_name, f.tz, f.plan_status, f.trial_ends_at,
       f.current_period_end, f.past_due_since, f.cancel_at_period_end, f.stripe_subscription_id IS NOT NULL AS subscribed, f.closed_at, f.region
     FROM users u JOIN firms f ON f.id = u.firm_id WHERE u.id = ?`,
  )
    .bind(session.userId)
    .first<{
      id: string;
      email: string;
      name: string | null;
      role: string;
      firm_id: string;
      firm_name: string | null;
      tz: string;
      plan_status: string;
      trial_ends_at: number | null;
      current_period_end: number | null;
      past_due_since: number | null;
      cancel_at_period_end: number;
      subscribed: number;
      closed_at: number | null;
      region: string;
    }>();
  if (!row) return c.json({ error: "unauthorized" }, 401);
  // a closed account that still holds records on legal hold can be reopened after the 30 days
  const held =
    row.closed_at !== null && isRegion(row.region)
      ? Boolean(await regionOf(c.env, row.region).db.prepare("SELECT 1 FROM requests WHERE firm_id = ? AND hold_at IS NOT NULL AND deleted_at IS NULL").bind(row.firm_id).first())
      : false;
  return c.json({
    user: { id: row.id, email: row.email, name: row.name, role: row.role },
    firm: {
      id: row.firm_id,
      name: row.firm_name,
      tz: row.tz,
      plan_status: row.plan_status,
      trial_ends_at: row.trial_ends_at,
      current_period_end: row.current_period_end,
      past_due_since: row.past_due_since,
      cancel_at_period_end: row.cancel_at_period_end === 1,
      subscribed: row.subscribed === 1,
      closed_at: row.closed_at,
      held,
      usable: usable(row, Date.now()),
    },
  });
});
