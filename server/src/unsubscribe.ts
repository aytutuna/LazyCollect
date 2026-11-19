import { Hono, type Context } from "hono";
import { rateLimited } from "./auth";
import { auditClient } from "./audit";
import { escapeHtml } from "./email";
import { htmlHeaders } from "./headers";
import { readUnsubToken } from "./mail";
import { regionOf } from "./regions";
import type { AppEnv } from "./session";
import { hmac, ipPrefix } from "./util";

export const unsubscribe = new Hono<AppEnv>();

const page = (c: Context, status: 200 | 404, body: string) =>
  c.html(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Email preferences</title><link rel="stylesheet" href="/link.css"><body>${body}</body>`, status, {
    ...htmlHeaders,
    "Cache-Control": "no-store",
  });

async function find(c: Context<AppEnv>, who: NonNullable<Awaited<ReturnType<typeof readUnsubToken>>>) {
  const db = regionOf(c.env, who.region).db;
  const client = await db
    .prepare("SELECT name, email FROM clients WHERE firm_id = ? AND id = ?")
    .bind(who.firmId, who.clientId)
    .first<{ name: string; email: string | null }>();
  if (!client) return null;
  const firm = await c.env.CONTROL.prepare("SELECT COALESCE(legal_name, name) AS sender FROM firms WHERE id = ?").bind(who.firmId).first<{ sender: string | null }>();
  return { ...who, db, client, sender: firm?.sender ?? "the sender" };
}

const invalid = (c: Context) => page(c, 404, "<p>This link is not valid.</p>");

// A GET only shows the button: mail scanners open links, and they must not unsubscribe anyone.
unsubscribe.get("/:token", async (c) => {
  const who = await readUnsubToken(c.env, c.req.param("token"));
  const found = who && (await find(c, who));
  if (!found) return invalid(c);
  return page(
    c,
    200,
    `<p>Stop emails about document requests from <b>${escapeHtml(found.sender)}</b> to ${escapeHtml(found.client.email ?? "your address")}?</p>
<form method="post"><button>Stop these emails</button></form>`,
  );
});

// the same endpoint takes the one-click POST that mail apps send for List-Unsubscribe
unsubscribe.post("/:token", async (c) => {
  // the signature is checked first, so only a real token can reach the limiter or the database
  const who = await readUnsubToken(c.env, c.req.param("token"));
  if (!who) return invalid(c);
  const ip = c.req.header("CF-Connecting-IP");
  if (await rateLimited(c.env, c.env.CLIENT, ip)) return c.json({ error: "rate_limited" }, 429);
  const found = await find(c, who);
  if (!found) return invalid(c);
  const { db, firmId, clientId } = found;
  const ipHash = await hmac(c.env.HASH_KEY, ipPrefix(ip ?? "unknown"));
  // the audit row goes first so only the first stop is recorded
  await db.batch([
    auditClient(db, firmId, ipHash, "email.unsubscribe", "client", clientId, {}, {
      sql: "EXISTS (SELECT 1 FROM clients WHERE firm_id = ? AND id = ? AND email_stop_at IS NULL)",
      binds: [firmId, clientId],
    }),
    db.prepare("UPDATE clients SET email_stop_at = ? WHERE firm_id = ? AND id = ? AND email_stop_at IS NULL").bind(Date.now(), firmId, clientId),
  ]);
  return page(c, 200, `<p>Done. ${escapeHtml(found.sender)} will not send you any more emails about document requests.</p>`);
});
