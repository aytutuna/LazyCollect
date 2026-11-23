import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DAY, HOUR, randomId, randomToken, sha256 } from "./util";

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

export async function createSession(c: Context<AppEnv>, userId: string, firmId: string) {
  const token = randomToken();
  const now = Date.now();
  await c.env.CONTROL.prepare(
    "INSERT INTO sessions (id, token_hash, user_id, firm_id, label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(randomId(), await sha256(token), userId, firmId, deviceLabel(c.req.header("User-Agent")), now, now, now + LIFETIME)
    .run();
  setSessionCookie(c, token);
}

export async function endSession(c: Context<AppEnv>) {
  const session = c.get("session");
  if (session) await c.env.CONTROL.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.tokenHash).run();
  deleteCookie(c, COOKIE, { path: "/", secure: true });
}

export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("session", null);
  const token = getCookie(c, COOKIE);
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
      c.set("session", { id: row.id, tokenHash, userId: row.user_id, firmId: row.firm_id });
      if (now - row.last_seen_at > HOUR) {
        await c.env.CONTROL.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
          .bind(now, now + LIFETIME, tokenHash)
          .run();
        setSessionCookie(c, token);
      }
    }
  }
  await next();
};
