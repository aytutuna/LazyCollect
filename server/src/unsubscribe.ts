import { Hono, type Context } from "hono";
import { rateLimited } from "./auth";
import { auditClient } from "./audit";
import { escapeHtml } from "./email";
import { htmlHeaders } from "./headers";
import { pageLang, type Lang } from "./lang";
import { readUnsubToken, stopHash } from "./mail";
import { regionOf } from "./regions";
import type { AppEnv } from "./session";
import { hmac, ipPrefix } from "./util";

export const unsubscribe = new Hono<AppEnv>();

const WORDS = {
  en: {
    title: "Email preferences",
    invalid: "This link is not valid.",
    sender: "the sender",
    address: "your address",
    ask: (sender: string, to: string) => `Stop emails about document requests from <b>${sender}</b>${to}?`,
    to: (email: string) => ` to ${email}`,
    button: "Stop these emails",
    done: (sender: string) => `Done. ${sender} will not send you any more emails about document requests.`,
  },
  "fr-CA": {
    title: "Préférences de courriel",
    invalid: "Ce lien n'est pas valide.",
    sender: "l'expéditeur",
    address: "votre adresse",
    ask: (sender: string, to: string) => `Ne plus recevoir de courriels au sujet de demandes de documents de la part de <b>${sender}</b>${to}?`,
    to: (email: string) => ` à ${email}`,
    button: "Ne plus recevoir ces courriels",
    done: (sender: string) => `C'est fait. ${sender} ne vous enverra plus de courriels au sujet de demandes de documents.`,
  },
} as const;

const langOf = (c: Context): Lang => pageLang(c.req.query("lang"), c.req.header("Accept-Language"));

const page = (c: Context, status: 200 | 404, body: string) =>
  c.html(`<!doctype html><html lang="${langOf(c)}"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>${WORDS[langOf(c)].title}</title><link rel="stylesheet" href="/link.css"><body>${body}</body>`, status, {
    ...htmlHeaders,
    "Cache-Control": "no-store",
  });

type Who = NonNullable<Awaited<ReturnType<typeof readUnsubToken>>>;

// the client may be gone, or have another address now; a token that names its address still works then
async function find(c: Context<AppEnv>, who: Who) {
  const db = regionOf(c.env, who.region).db;
  const client = await db
    .prepare("SELECT name, email FROM clients WHERE firm_id = ? AND id = ?")
    .bind(who.firmId, who.clientId)
    .first<{ name: string; email: string | null }>();
  if (!client && !who.hash) return null;
  const firm = await c.env.CONTROL.prepare("SELECT COALESCE(legal_name, name) AS sender FROM firms WHERE id = ?").bind(who.firmId).first<{ sender: string | null }>();
  // a purged account has nothing left to attach a stop to
  if (!firm) return null;
  return { ...who, db, client, sender: firm.sender };
}

const invalid = (c: Context) => page(c, 404, `<p>${WORDS[langOf(c)].invalid}</p>`);

// A GET only shows the button: mail scanners open links, and they must not unsubscribe anyone.
unsubscribe.get("/:token", async (c) => {
  const who = await readUnsubToken(c.env, c.req.param("token"));
  const found = who && (await find(c, who));
  if (!found) return invalid(c);
  const w = WORDS[langOf(c)];
  const sender = escapeHtml(found.sender ?? w.sender);
  return page(c, 200, `<p>${w.ask(sender, found.hash ? "" : w.to(escapeHtml(found.client?.email ?? w.address)))}</p>
<form method="post"><button>${w.button}</button></form>`);
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
  const { db, firmId, clientId, client } = found;
  const ipHash = await hmac(c.env.HASH_KEY, ipPrefix(ip ?? "unknown"));
  // an older token has no address, so the client's current one stands in
  const hash = who.hash ?? (client?.email ? await stopHash(c.env, client.email) : null);
  // the client row is only marked while it still holds the address the email went to
  const holds = Boolean(client?.email && hash && (await stopHash(c.env, client.email)) === hash);
  // the audit row goes first so only the first stop is recorded
  await db.batch([
    auditClient(db, firmId, ipHash, "email.unsubscribe", "client", clientId, {}, hash
      ? { sql: "NOT EXISTS (SELECT 1 FROM email_stops WHERE firm_id = ? AND email_hash = ?)", binds: [firmId, hash] }
      : { sql: "EXISTS (SELECT 1 FROM clients WHERE firm_id = ? AND id = ? AND email_stop_at IS NULL)", binds: [firmId, clientId] }),
    ...(holds ? [db.prepare("UPDATE clients SET email_stop_at = ? WHERE firm_id = ? AND id = ? AND email_stop_at IS NULL").bind(Date.now(), firmId, clientId)] : []),
    ...(hash ? [db.prepare("INSERT OR IGNORE INTO email_stops (firm_id, email_hash, stopped_at) VALUES (?, ?, ?)").bind(firmId, hash, Date.now())] : []),
  ]);
  const w = WORDS[langOf(c)];
  return page(c, 200, `<p>${w.done(escapeHtml(found.sender ?? w.sender))}</p>`);
});
