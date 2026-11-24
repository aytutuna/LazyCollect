import { Hono, type Context } from "hono";
import { need, normalizeEmail, rateLimited, sendCode, verifyCode } from "./auth";
import { attestKey, attested, checked, issueChallenge, usable } from "./attest";
import { findLink, sessionLink } from "./client";
import { bearerOf, createClientSession, isApp, type AppEnv } from "./session";
import { sha256 } from "./util";
import { invalid, notFound, readBody, text } from "./validate";

// What the phone apps use in place of the browser's cookies and Turnstile.
export const native = new Hono<AppEnv>();

const notReady = (c: Context) => c.json({ error: "unavailable" }, 503);

native.post("/app/challenge", async (c) => {
  if (await rateLimited(c.env, c.env.APP, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  const body = await readBody(c);
  if (!isApp(body?.platform)) return invalid(c);
  if (!usable(c.env, body.platform)) return notReady(c);
  return c.json({ challenge: await issueChallenge(c.env), required: checked(c.env, body.platform) });
});

// an iPhone attests its App Attest key once, before its first assertion
native.post("/app/attest", async (c) => {
  if (await rateLimited(c.env, c.env.APP, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  const body = await readBody(c);
  if (typeof body?.key_id !== "string" || typeof body.challenge !== "string" || typeof body.attestation !== "string") return invalid(c);
  if (!usable(c.env, "ios")) return notReady(c);
  return (await attestKey(c.env, body.key_id, body.challenge, body.attestation)) ? c.json({ ok: true }) : c.json({ error: "attestation" }, 400);
});

native.post("/app/auth/start", async (c) => {
  const body = await readBody(c);
  const email = normalizeEmail(body?.email);
  if (!email) return c.json({ error: "invalid_email" }, 400);
  if (!isApp(body?.platform)) return invalid(c);
  if (!usable(c.env, body.platform)) return notReady(c);
  need(c.env, "RESEND_API_KEY", "HASH_KEY");
  if (await rateLimited(c.env, c.env.LOGIN, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  if (!(await attested(c.env, body.platform, body.attestation, email))) return c.json({ error: "attestation" }, 400);
  return sendCode(c, email, body.platform);
});

native.post("/app/auth/verify", async (c) => {
  const body = await readBody(c);
  if (!isApp(body?.platform)) return invalid(c);
  if (!usable(c.env, body.platform)) return notReady(c);
  return verifyCode(c, body.platform);
});

// The client's link, as the email carries it, for a session of the app's own. The link keeps working on the web.
native.post("/app/client/exchange", async (c) => {
  const body = await readBody(c);
  if (typeof body?.token !== "string" || !isApp(body.platform)) return invalid(c);
  if (!usable(c.env, body.platform)) return notReady(c);
  if (await rateLimited(c.env, c.env.CLIENT, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  if (!(await attested(c.env, body.platform, body.attestation, body.token))) return c.json({ error: "attestation" }, 400);
  const link = await findLink(c.env, body.token);
  if (!link) return notFound(c);
  return c.json({ token: await createClientSession(c, link.region, link.hash, body.platform), expires_at: link.req.expires_at });
});

native.post("/app/client/logout", async (c) => {
  const token = bearerOf(c);
  if (token) await c.env.CONTROL.prepare("DELETE FROM client_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return c.json({ ok: true });
});

// Where this app session can be sent a push. Sending is not built; the token lives and dies with the session.
async function setPush(c: Context<AppEnv>, push: string | null) {
  const token = bearerOf(c);
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const hash = await sha256(token);
  const now = Date.now();
  // a client session whose link is gone has nothing to be notified about
  const live = await sessionLink(c);
  const [staff, client] = await c.env.CONTROL.batch([
    c.env.CONTROL.prepare("UPDATE sessions SET push_token = ? WHERE token_hash = ? AND app IS NOT NULL AND expires_at > ?").bind(push, hash, now),
    c.env.CONTROL.prepare("UPDATE client_sessions SET push_token = ? WHERE token_hash = ? AND expires_at > ? AND ?").bind(push, hash, now, live ? 1 : 0),
  ]);
  if (staff.meta.changes + client.meta.changes === 0) return c.json({ error: "unauthorized" }, 401);
  // An install has one token shared by all its sessions, so only a staff session of someone else is made to give it up.
  if (push && staff.meta.changes) {
    await c.env.CONTROL.prepare("UPDATE sessions SET push_token = NULL WHERE push_token = ? AND user_id != (SELECT user_id FROM sessions WHERE token_hash = ?)").bind(push, hash).run();
  }
  return c.json({ ok: true });
}

native.put("/app/push", async (c) => {
  const push = text((await readBody(c))?.token, 4096);
  return push ? setPush(c, push) : invalid(c);
});

native.delete("/app/push", (c) => setPush(c, null));
