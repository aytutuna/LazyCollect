import { Hono, type Context } from "hono";
import { createSession, endSession, type AppEnv } from "./session";
import { sendLoginEmail } from "./email";
import { DAY, MINUTE, hmac, randomCode, randomId, randomToken, sha256 } from "./util";

export const auth = new Hono<AppEnv>();

const CODE_TTL = 10 * MINUTE;
const MAX_CODES = 3;
const MAX_ATTEMPTS = 3;
const TRIAL_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type CodeRow = { id: string; email: string; code_hash: string };

function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const email = v.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

async function turnstileOk(env: Env, token: unknown, ip: string | undefined): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) throw new Error("TURNSTILE_SECRET is not set");
  if (typeof token !== "string" || !token) return false;
  const res = await fetch(`${env.TURNSTILE_BASE ?? "https://challenges.cloudflare.com"}/turnstile/v0/siteverify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return false;
  const body = await res.json<{ success?: boolean }>();
  return body.success === true;
}

async function rateLimited(env: Env, ip: string): Promise<boolean> {
  if (!env.LOGIN || !env.RATE_SALT) throw new Error("login rate limit is not configured");
  const { success } = await env.LOGIN.limit({ key: await hmac(env.RATE_SALT, ip) });
  return !success;
}

auth.post("/auth/start", async (c) => {
  const body = await c.req.json<{ email?: unknown; turnstile?: unknown }>().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) return c.json({ error: "invalid_email" }, 400);
  const ip = c.req.header("CF-Connecting-IP");
  if (await rateLimited(c.env, ip ?? "unknown")) return c.json({ error: "rate_limited" }, 429);
  if (!(await turnstileOk(c.env, body?.turnstile, ip))) return c.json({ error: "turnstile" }, 400);

  const now = Date.now();
  const emailHash = await sha256(email);
  const recent = await c.env.CONTROL.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE email_hash = ? AND created_at > ?")
    .bind(emailHash, now - CODE_TTL)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_CODES) return c.json({ ok: true });

  const code = randomCode();
  const linkToken = randomToken();
  await c.env.CONTROL.prepare(
    `INSERT INTO login_codes (id, email, email_hash, code_hash, link_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(randomId(), email, emailHash, await sha256(`${emailHash}:${code}`), await sha256(linkToken), now + CODE_TTL, now)
    .run();
  await sendLoginEmail(c.env, email, code, `${c.env.APP_URL}/api/auth/link?t=${linkToken}`);
  return c.json({ ok: true });
});

async function signIn(c: Context<AppEnv>, email: string): Promise<boolean> {
  const db = c.env.CONTROL;
  let user = await db
    .prepare("SELECT id, firm_id, disabled_at FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; firm_id: string; disabled_at: number | null }>();
  if (user?.disabled_at) return false;
  if (!user) {
    const now = Date.now();
    const firmId = randomId();
    const userId = randomId();
    await db.batch([
      db
        .prepare("INSERT INTO firms (id, plan_status, trial_ends_at, created_at) VALUES (?, 'trialing', ?, ?)")
        .bind(firmId, now + TRIAL_DAYS * DAY, now),
      db
        .prepare("INSERT INTO users (id, firm_id, email, role, created_at) VALUES (?, ?, ?, 'owner', ?)")
        .bind(userId, firmId, email, now),
    ]);
    user = { id: userId, firm_id: firmId, disabled_at: null };
  }
  await createSession(c, user.id, user.firm_id);
  return true;
}

async function useCode(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("UPDATE login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(Date.now(), id).run();
  return res.meta.changes === 1;
}

auth.post("/auth/verify", async (c) => {
  const body = await c.req.json<{ email?: unknown; code?: unknown }>().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email || typeof body?.code !== "string") return c.json({ error: "invalid" }, 400);
  const db = c.env.CONTROL;
  const emailHash = await sha256(email);
  const row = await db
    .prepare(
      `SELECT id, email, code_hash FROM login_codes
       WHERE email_hash = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(emailHash, Date.now(), MAX_ATTEMPTS)
    .first<CodeRow>();
  if (!row) return c.json({ error: "invalid" }, 400);
  // count the try before comparing so parallel guesses can't exceed the limit
  const tried = await db
    .prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ?")
    .bind(row.id, MAX_ATTEMPTS)
    .run();
  if (tried.meta.changes !== 1 || (await sha256(`${emailHash}:${body.code.trim()}`)) !== row.code_hash) {
    return c.json({ error: "invalid" }, 400);
  }
  if (!(await useCode(db, row.id))) return c.json({ error: "invalid" }, 400);
  if (!(await signIn(c, row.email))) return c.json({ error: "disabled" }, 403);
  return c.json({ ok: true });
});

auth.get("/auth/link", async (c) => {
  const t = c.req.query("t");
  if (!t) return c.text("Invalid or expired link", 400);
  const db = c.env.CONTROL;
  const row = await db
    .prepare("SELECT id, email FROM login_codes WHERE link_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(await sha256(t), Date.now())
    .first<CodeRow>();
  if (!row || !(await useCode(db, row.id))) return c.text("Invalid or expired link", 400);
  if (!(await signIn(c, row.email))) return c.text("This account is disabled", 403);
  return c.redirect("/", 302);
});

auth.post("/auth/logout", async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const row = await c.env.CONTROL.prepare(
    `SELECT u.id, u.email, u.name, u.role, f.id AS firm_id, f.name AS firm_name, f.plan_status, f.trial_ends_at
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
      plan_status: string;
      trial_ends_at: number | null;
    }>();
  if (!row) return c.json({ error: "unauthorized" }, 401);
  return c.json({
    user: { id: row.id, email: row.email, name: row.name, role: row.role },
    firm: { id: row.firm_id, name: row.firm_name, plan_status: row.plan_status, trial_ends_at: row.trial_ends_at },
  });
});
