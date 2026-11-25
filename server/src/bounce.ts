import { Hono } from "hono";
import { regionIds, regionOf } from "./regions";
import type { AppEnv } from "./session";
import { MINUTE } from "./util";

export const resendWebhook = new Hono<AppEnv>();

const MAX_BODY = 64 * 1024;
const encoder = new TextEncoder();

// Resend signs with Svix: HMAC-SHA256 over "id.timestamp.body" with the base64 part of the whsec_ secret
export async function verifySvix(body: string, headers: { id?: string; timestamp?: string; signature?: string }, secret: string, now: number): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !secret.startsWith("whsec_")) return false;
  const stamp = Number(timestamp);
  if (!Number.isFinite(stamp) || Math.abs(now - stamp * 1000) > 5 * MINUTE) return false;
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(secret.slice(6)), (ch) => ch.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const data = encoder.encode(`${id}.${timestamp}.${body}`);
  let ok = false;
  for (const part of signature.split(" ").slice(0, 5)) {
    if (!part.startsWith("v1,")) continue;
    try {
      const sig = Uint8Array.from(atob(part.slice(3)), (ch) => ch.charCodeAt(0));
      if (await crypto.subtle.verify("HMAC", key, sig, data)) ok = true;
    } catch {
      // not base64: not a signature
    }
  }
  return ok;
}

type Event = { type?: string; data?: { email_id?: string; to?: string[]; bounce?: { type?: string } } };

// A permanent bounce marks the message and the client who has that address now. A client whose address was changed
// since the email went out is left alone.
export async function markBounced(env: Env, emailId: string, to: string, now: number) {
  for (const region of regionIds) {
    const { db } = regionOf(env, region);
    const hit = await db
      .prepare("UPDATE messages SET bounced_at = ? WHERE provider_id = ? AND bounced_at IS NULL RETURNING firm_id, client_id")
      .bind(now, emailId)
      .first<{ firm_id: string; client_id: string }>();
    if (!hit) continue;
    await db
      .prepare("UPDATE clients SET email_bounced_at = ? WHERE firm_id = ? AND id = ? AND lower(email) = lower(?)")
      .bind(now, hit.firm_id, hit.client_id, to)
      .run();
    return;
  }
}

resendWebhook.post("/resend/webhook", async (c) => {
  if (!c.env.RESEND_WEBHOOK_SECRET) return c.json({ error: "unavailable" }, 503);
  const length = c.req.header("Content-Length");
  if (!length || !/^\d+$/.test(length)) return c.json({ error: "length_required" }, 411);
  if (Number(length) > MAX_BODY) return c.json({ error: "too_big" }, 413);
  const raw = await c.req.text();
  if (raw.length > MAX_BODY) return c.json({ error: "too_big" }, 413);
  const signed = await verifySvix(raw, { id: c.req.header("svix-id"), timestamp: c.req.header("svix-timestamp"), signature: c.req.header("svix-signature") }, c.env.RESEND_WEBHOOK_SECRET, Date.now());
  if (!signed) return c.json({ error: "invalid" }, 400);
  let event: Event;
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid" }, 400);
  }
  const { email_id: id, to, bounce } = event.data ?? {};
  if (event.type === "email.bounced" && bounce?.type === "Permanent" && typeof id === "string" && typeof to?.[0] === "string") {
    await markBounced(c.env, id, to[0], Date.now());
  }
  return c.json({ ok: true });
});
