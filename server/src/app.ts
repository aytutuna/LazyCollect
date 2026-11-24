import { Hono } from "hono";
import { need, normalizeEmail, rateLimited, sendCode, verifyCode } from "./auth";
import { attestKey, attested, checked, issueChallenge } from "./attest";
import { isApp, type AppEnv } from "./session";
import { invalid, readBody } from "./validate";

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
