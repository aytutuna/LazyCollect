import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DAY, HOUR, MINUTE, randomId, randomToken, sha256 } from "./util";

export type App = "android" | "ios";
export const isApp = (v: unknown): v is App => v === "android" || v === "ios";
const APP_LABELS: Record<App, string> = { android: "Lazy Collect for Android", ios: "Lazy Collect for iPhone" };

export type Session = { id: string | null; tokenHash: string; userId: string; firmId: string };
export type Firm = {
  id: string;
  name: string | null;
  legal_name: string | null;
  address: string | null;
  phone: string | null;
  province: string | null;
  tz: string;
  region: string;
  plan_status: string;
  trial_ends_at: number | null;
  current_period_end: number | null;
  past_due_since: number | null;
  cancel_at_period_end: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  closed_at: number | null;
  require_passkeys: number;
};
export type AppEnv = { Bindings: Env; Variables: { session: Session | null; firm: Firm; db: D1Database } };

const COOKIE = "__Host-lc_session";
const LIFETIME = 30 * DAY;

function setSessionCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: LIFETIME / 1000,
  });
}

// a short name for the sessions list; the raw user agent is not kept
export function deviceLabel(ua: string | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : null;
  return browser && os ? `${browser} on ${os}` : (browser ?? os ?? "Unknown device");
}

export function bearerOf(c: Context, scheme = "Bearer"): string | undefined {
  const h = c.req.header("Authorization");
  return h?.startsWith(`${scheme} `) ? h.slice(scheme.length + 1).trim() || undefined : undefined;
}

// An app keeps the returned token and sends it as a bearer; a browser gets it as a cookie.
export async function createSession(c: Context<AppEnv>, userId: string, firmId: string, app: App | null = null): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await c.env.CONTROL.prepare(
    "INSERT INTO sessions (id, token_hash, user_id, firm_id, label, app, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(randomId(), await sha256(token), userId, firmId, app ? APP_LABELS[app] : deviceLabel(c.req.header("User-Agent")), app, now, now, now + LIFETIME)
    .run();
  if (!app) setSessionCookie(c, token);
  return token;
}

export async function endSession(c: Context<AppEnv>) {
  const session = c.get("session");
  if (session) await c.env.CONTROL.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.tokenHash).run();
  deleteCookie(c, COOKIE, { path: "/", secure: true });
}

export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("session", null);
  const bearer = bearerOf(c);
  const token = bearer ?? getCookie(c, COOKIE);
  if (token) {
    const tokenHash = await sha256(token);
    const now = Date.now();
    const row = await c.env.CONTROL.prepare(
      `SELECT s.id, s.user_id, s.firm_id, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL AND u.firm_id = s.firm_id`,
    )
      .bind(tokenHash, now)
      .first<{ id: string | null; user_id: string; firm_id: string; last_seen_at: number }>();
    if (row) {
      // a session made before the id column existed gets one now, so it can be ended on its own
      if (row.id === null) {
        row.id = randomId();
        await c.env.CONTROL.prepare("UPDATE sessions SET id = ? WHERE token_hash = ? AND id IS NULL").bind(row.id, tokenHash).run();
      }
      c.set("session", { id: row.id, tokenHash, userId: row.user_id, firmId: row.firm_id });
      if (now - row.last_seen_at > HOUR) {
        await c.env.CONTROL.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
          .bind(now, now + LIFETIME, tokenHash)
          .run();
        if (!bearer) setSessionCookie(c, token);
      }
    }
  }
  await next();
};

// A good email code or link that still owes a passkey. It is not a session: loadSession never looks at this cookie.
const PENDING_COOKIE = "__Host-lc_pending";
const PENDING_TTL = 5 * MINUTE;
export const PENDING_TRIES = 5;

export type Pending = { tokenHash: string; userId: string; firmId: string; step: "passkey" | "enrol"; app: App | null; role: string; email: string; name: string | null };

// An app gets the token back and sends it as `Authorization: Pending <token>`.
export async function holdLogin(c: Context<AppEnv>, userId: string, step: Pending["step"], app: App | null = null): Promise<string> {
  const token = randomToken();
  await c.env.CONTROL.batch([
    c.env.CONTROL.prepare("DELETE FROM pending_logins WHERE user_id = ?").bind(userId),
    c.env.CONTROL.prepare("INSERT INTO pending_logins (token_hash, user_id, step, app, expires_at) VALUES (?, ?, ?, ?, ?)").bind(await sha256(token), userId, step, app, Date.now() + PENDING_TTL),
  ]);
  if (!app) setCookie(c, PENDING_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: PENDING_TTL / 1000 });
  return token;
}

export async function loadPending(c: Context<AppEnv>): Promise<Pending | null> {
  const token = bearerOf(c, "Pending") ?? getCookie(c, PENDING_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await c.env.CONTROL.prepare(
    `SELECT p.step, p.app, u.id AS user_id, u.firm_id, u.role, u.email, u.name FROM pending_logins p JOIN users u ON u.id = p.user_id
     WHERE p.token_hash = ? AND p.expires_at > ? AND u.disabled_at IS NULL`,
  )
    .bind(tokenHash, Date.now())
    .first<{ step: Pending["step"]; app: App | null; user_id: string; firm_id: string; role: string; email: string; name: string | null }>();
  return row && { tokenHash, userId: row.user_id, firmId: row.firm_id, step: row.step, app: row.app, role: row.role, email: row.email, name: row.name };
}

export async function endPending(c: Context<AppEnv>) {
  const token = bearerOf(c, "Pending") ?? getCookie(c, PENDING_COOKIE);
  if (token) await c.env.CONTROL.prepare("DELETE FROM pending_logins WHERE token_hash = ?").bind(await sha256(token)).run();
  deleteCookie(c, PENDING_COOKIE, { path: "/", secure: true });
}
