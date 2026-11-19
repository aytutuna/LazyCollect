import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DAY, randomToken, sha256 } from "./util";

export type Session = { tokenHash: string; userId: string; firmId: string };
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

export async function createSession(c: Context<AppEnv>, userId: string, firmId: string) {
  const token = randomToken();
  const now = Date.now();
  await c.env.CONTROL.prepare(
    "INSERT INTO sessions (token_hash, user_id, firm_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256(token), userId, firmId, now, now, now + LIFETIME)
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
      `SELECT s.user_id, s.firm_id, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL`,
    )
      .bind(tokenHash, now)
      .first<{ user_id: string; firm_id: string; last_seen_at: number }>();
    if (row) {
      c.set("session", { tokenHash, userId: row.user_id, firmId: row.firm_id });
      if (now - row.last_seen_at > DAY) {
        await c.env.CONTROL.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
          .bind(now, now + LIFETIME, tokenHash)
          .run();
        setSessionCookie(c, token);
      }
    }
  }
  await next();
};
