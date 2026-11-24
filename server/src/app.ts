import { Hono } from "hono";
import { need, normalizeEmail, rateLimited, sendCode, verifyCode } from "./auth";
import { attestKey, attested, checked, issueChallenge } from "./attest";
import { findLink } from "./client";
import { bearerOf, createClientSession, isApp, type AppEnv } from "./session";
import { sha256 } from "./util";
import { invalid, notFound, readBody } from "./validate";

// What the phone apps use in place of the browser's cookies and Turnstile.
export const native = new Hono<AppEnv>();

native.post("/app/challenge", async (c) => {
  if (await rateLimited(c.env, c.env.APP, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  const body = await readBody(c);
  if (!isApp(body?.platform)) return invalid(c);
  return c.json({ challenge: await issueChallenge(c.env), required: checked(c.env, body.platform) });
});

// an iPhone attests its App Attest key once, before its first assertion
native.post("/app/attest", async (c) => {
  if (await rateLimited(c.env, c.env.APP, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  const body = await readBody(c);
  if (typeof body?.key_id !== "string" || typeof body.challenge !== "string" || typeof body.attestation !== "string") return invalid(c);
  return (await attestKey(c.env, body.key_id, body.challenge, body.attestation)) ? c.json({ ok: true }) : c.json({ error: "attestation" }, 400);
});

native.post("/app/auth/start", async (c) => {
  const body = await readBody(c);
  const email = normalizeEmail(body?.email);
  if (!email) return c.json({ error: "invalid_email" }, 400);
  if (!isApp(body?.platform)) return invalid(c);
  need(c.env, "RESEND_API_KEY", "HASH_KEY");
  if (await rateLimited(c.env, c.env.LOGIN, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  if (!(await attested(c.env, body.platform, body.attestation, email))) return c.json({ error: "attestation" }, 400);
  return sendCode(c, email);
});

native.post("/app/auth/verify", async (c) => {
  const body = await readBody(c);
  if (!isApp(body?.platform)) return invalid(c);
  return verifyCode(c, body.platform);
});

// The client's link, as the email carries it, for a session of the app's own. The link keeps working on the web.
native.post("/app/client/exchange", async (c) => {
  const body = await readBody(c);
  if (typeof body?.token !== "string" || !isApp(body.platform)) return invalid(c);
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
