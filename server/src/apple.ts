import "reflect-metadata";
import { X509Certificate, X509ChainBuilder } from "@peculiar/x509";
import { Hono } from "hono";
import { local } from "./attest";
import { audit } from "./audit";
import { isOwner, usable } from "./firm";
import { classOf, itemFailed } from "./pulse";
import type { AppEnv, Firm } from "./session";
import { DAY, FETCH_TIMEOUT_MS } from "./util";
import { invalid, notFound, readBody } from "./validate";

// The plan bought in the iPhone app: an auto-renewing subscription in App Store Connect. The phone only says which
// transaction it bought; what the plan is worth comes from Apple's App Store Server API, and Apple's server notifications
// (V2) only say which transaction to look at again.
export const BUNDLE_ID = "com.lazycollect.lazycollect";
export const PLAN_PRODUCT = "com.lazycollect.lazycollect.plan.monthly";

// https://www.apple.com/certificateauthority/AppleRootCA-G3.cer, SHA-256 63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179
export const APPLE_ROOT_G3 = `
-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----
`;

// marks of Apple's own signing certificates: any other certificate Apple's root has signed (developer certificates among them) is refused
const INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";
const LEAF_OID = "1.2.840.113635.100.6.11.1";

const PRODUCTION = "https://api.storekit.itunes.apple.com";
const SANDBOX = "https://api.storekit-sandbox.itunes.apple.com";
const MAX_BODY = 64 * 1024;

const encoder = new TextEncoder();
const unb64url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const json = (s: string) => JSON.parse(new TextDecoder().decode(unb64url(s)));

type Claims = Record<string, any>;

// A JWS Apple signed: its leaf and intermediate certificates carry Apple's marks and chain to the pinned root.
export async function verifyJws(env: Env, jws: unknown): Promise<Claims | null> {
  try {
    const parts = typeof jws === "string" ? jws.split(".") : [];
    if (parts.length !== 3) return null;
    const header = json(parts[0]);
    if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length !== 3) return null;
    const [leaf, intermediate, top] = (header.x5c as string[]).map((c) => new X509Certificate(c));
    const root = new X509Certificate((local(env) && env.APPLE_IAP_ROOT) || APPLE_ROOT_G3);
    if (!top.equal(root) || !leaf.getExtension(LEAF_OID) || !intermediate.getExtension(INTERMEDIATE_OID)) return null;
    const chain = await new X509ChainBuilder({ certificates: [intermediate, root] }).build(leaf);
    if (chain.length !== 3 || !chain[2].equal(root)) return null;
    const claims = json(parts[1]);
    // the certificates must have been valid when Apple signed, as its own libraries check
    const at = typeof claims.signedDate === "number" ? claims.signedDate : Date.now();
    if (![leaf, intermediate].every((x) => x.notBefore.getTime() <= at && at <= x.notAfter.getTime())) return null;
    const key = await crypto.subtle.importKey("spki", leaf.publicKey.rawData, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const signed = encoder.encode(`${parts[0]}.${parts[1]}`);
    return (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64url(parts[2]), signed)) ? claims : null;
  } catch {
    return null;
  }
}

// the plan can be bought only once the key for Apple's API is in place
export const configured = (env: Env) => Boolean(env.APPLE_IAP_KEY && env.APPLE_IAP_KEY_ID && env.APPLE_ISSUER_ID);

async function apiToken(env: Env): Promise<string> {
  const pem = env.APPLE_IAP_KEY!.replace(/-----[A-Z ]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: env.APPLE_IAP_KEY_ID, typ: "JWT" })));
  const body = b64url(encoder.encode(JSON.stringify({ iss: env.APPLE_ISSUER_ID, iat: now, exp: now + 300, aud: "appstoreconnect-v1", bid: BUNDLE_ID })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

// null when Apple has no such transaction
async function appleGet(env: Env, path: string, timeout = FETCH_TIMEOUT_MS): Promise<any | null> {
  // sandbox purchases are free, so the live Worker looks there only while APPLE_IAP_SANDBOX is on (App Review, TestFlight)
  // APPLE_API_BASE is for tests and local runs; a live Worker always talks to Apple
  const bases = local(env) && env.APPLE_API_BASE ? [env.APPLE_API_BASE] : env.APPLE_IAP_SANDBOX === "1" ? [PRODUCTION, SANDBOX] : [PRODUCTION];
  const token = await apiToken(env);
  for (const base of bases) {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeout) });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`App Store Server API answered ${res.status}`);
    return res.json();
  }
  return null;
}

export type Standing = {
  original: string;
  plan: "active" | "past_due" | "canceled";
  periodEnd: number;
  renews: boolean;
  token: string | null;
};

// Where the plan stands for a transaction of this subscription: Apple's own answer, for the plan's product in this app.
export async function standing(env: Env, transactionId: string, timeout?: number): Promise<Standing | null> {
  const body = await appleGet(env, `/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`, timeout);
  for (const group of body?.data ?? []) {
    for (const last of group.lastTransactions ?? []) {
      const tx = await verifyJws(env, last.signedTransactionInfo);
      if (!tx || tx.bundleId !== BUNDLE_ID || tx.productId !== PLAN_PRODUCT || typeof tx.originalTransactionId !== "string") continue;
      if (tx.environment === "Sandbox" && env.APPLE_IAP_SANDBOX !== "1") continue;
      // the plan starts paid: the account's one trial is the web trial, so a store free trial is never taken
      if (tx.offerType === 1 && tx.offerDiscountType === "FREE_TRIAL") {
        console.error("App Store free trial refused");
        continue;
      }
      const renewal = last.signedRenewalInfo ? await verifyJws(env, last.signedRenewalInfo) : null;
      // 1 active, 2 expired, 3 in billing retry, 4 in the billing grace period, 5 revoked
      const plan = last.status === 1 || last.status === 4 ? "active" : last.status === 3 ? "past_due" : "canceled";
      // in the billing grace period the plan stays open until Apple's own grace date, which can be past the paid period
      const grace = last.status === 4 ? Number(renewal?.gracePeriodExpiresDate) || 0 : 0;
      return {
        original: tx.originalTransactionId,
        plan: tx.revocationDate ? "canceled" : plan,
        periodEnd: Math.max(Number(tx.expiresDate) || 0, grace),
        renews: renewal?.autoRenewStatus === 1,
        token: typeof tx.appAccountToken === "string" ? tx.appAccountToken.toLowerCase() : null,
      };
    }
  }
  return null;
}

// the account token the app puts on the purchase: the firm's id as a UUID, so a transaction can't be attached to another firm
export const accountToken = (firmId: string) => firmId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

// Apple reuses the original transaction id for the same Apple ID, so a purchase that names this firm takes the id from
// whichever firm held it before, in the same batch
async function apply(env: Env, firmId: string, s: Standing) {
  const now = Date.now();
  await env.CONTROL.batch([
    env.CONTROL.prepare(
      `UPDATE firms SET apple_original_transaction_id = NULL,
         plan_status = CASE WHEN plan_source = 'apple' THEN 'canceled' ELSE plan_status END,
         plan_source = CASE WHEN plan_source = 'apple' THEN NULL ELSE plan_source END
       WHERE apple_original_transaction_id = ? AND id != ?`,
    ).bind(s.original, firmId),
    env.CONTROL.prepare(
      `UPDATE firms SET plan_source = 'apple', apple_original_transaction_id = ?, plan_status = ?, current_period_end = ?, cancel_at_period_end = ?,
         past_due_since = CASE WHEN ? = 'past_due' THEN COALESCE(past_due_since, ?) ELSE NULL END, apple_checked_at = ? WHERE id = ?`,
    ).bind(s.original, s.plan, s.periodEnd || null, s.renews ? 0 : 1, s.plan, now, now, firmId),
  ]);
}

// Apple has no current answer for the subscription: the plan is over
const lose = (env: Env, firmId: string) => env.CONTROL.prepare("UPDATE firms SET plan_status = 'canceled', past_due_since = NULL WHERE id = ? AND plan_source = 'apple'").bind(firmId).run();

type Holder = Pick<Firm, "plan_status" | "plan_source" | "current_period_end" | "trial_ends_at" | "past_due_since" | "closed_at"> & { stripe_subscription_id: string | null; apple: string | null };

// Takes what Apple says for this firm, with the checks the purchase route and the notifications share; the reason it
// was refused, or null when the plan was applied.
async function attach(env: Env, firmId: string, found: Standing): Promise<"other_account" | "subscribed" | "not_active" | null> {
  if (found.token !== accountToken(firmId)) return "other_account";
  const f = await env.CONTROL.prepare(
    "SELECT plan_status, plan_source, current_period_end, trial_ends_at, past_due_since, closed_at, stripe_subscription_id, apple_original_transaction_id AS apple FROM firms WHERE id = ?",
  )
    .bind(firmId)
    .first<Holder>();
  if (!f) return "other_account";
  // one subscription per account: a plan bought on the web is changed there
  if (f.stripe_subscription_id && f.plan_source !== "apple" && ["active", "past_due", "trialing"].includes(f.plan_status)) return "subscribed";
  // an account with a live plan of its own keeps it: another transaction does not replace it
  if (f.apple && f.apple !== found.original && (f.plan_status === "active" || f.plan_status === "past_due") && usable(f, Date.now())) return "subscribed";
  // a first purchase that is already over must not end a running trial
  if (!f.apple && found.plan === "canceled") return "not_active";
  await apply(env, firmId, found);
  return null;
}

export const appleBilling = new Hono<AppEnv>();

appleBilling.post("/billing/apple", async (c) => {
  if (!(await isOwner(c))) return c.json({ error: "forbidden" }, 403);
  if (!configured(c.env)) return c.json({ error: "unavailable" }, 503);
  const body = await readBody(c);
  if (typeof body?.transaction_id !== "string" || !/^\d{1,20}$/.test(body.transaction_id)) return invalid(c);
  const firm = c.get("firm");
  let found: Standing | null;
  try {
    found = await standing(c.env, body.transaction_id);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "error");
    return c.json({ error: "billing" }, 502);
  }
  if (!found) return notFound(c);
  const refused = await attach(c.env, firm.id, found);
  if (refused) return c.json({ error: refused }, 409);
  await audit(c, "billing.apple", "firm", firm.id).run();
  return c.json({ ok: true, plan_status: found.plan });
});

export const appleWebhook = new Hono<AppEnv>();

// the body, or null when it is over the cap; Apple's calls may come without a length
async function boundedText(req: Request): Promise<string | null> {
  const length = req.headers.get("Content-Length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) return null;
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks).text();
}

// App Store Server Notifications V2. The signed payload says which transaction changed; the state is asked of Apple again.
appleWebhook.post("/apple/notifications", async (c) => {
  if (!configured(c.env)) return c.json({ error: "unavailable" }, 503);
  const raw = await boundedText(c.req.raw);
  if (raw === null) return c.json({ error: "too_big" }, 413);
  let signed: unknown;
  try {
    signed = JSON.parse(raw)?.signedPayload;
  } catch {
    return invalid(c);
  }
  const payload = await verifyJws(c.env, signed);
  if (!payload) return c.json({ error: "invalid" }, 400);
  const tx = await verifyJws(c.env, payload.data?.signedTransactionInfo);
  if (!tx || tx.bundleId !== BUNDLE_ID || typeof tx.originalTransactionId !== "string" || typeof tx.transactionId !== "string") return c.json({ ok: true });
  const holder = await c.env.CONTROL.prepare("SELECT id FROM firms WHERE apple_original_transaction_id = ? AND plan_source = 'apple'").bind(tx.originalTransactionId).first<{ id: string }>();
  // a purchase whose notice came before the app could say so: the account token names the firm, as in the purchase route
  const named = payload.notificationType === "SUBSCRIBED" && typeof tx.appAccountToken === "string" ? tx.appAccountToken.replaceAll("-", "").toLowerCase() : null;
  const firmId = named && /^[0-9a-f]{32}$/.test(named) ? named : holder?.id;
  if (!firmId) return c.json({ ok: true });
  try {
    const found = await standing(c.env, tx.transactionId);
    if (!found) {
      if (holder) await lose(c.env, holder.id);
    } else if (found.original === tx.originalTransactionId) {
      if (named) await attach(c.env, firmId, found);
      else if (found.token === accountToken(firmId)) await apply(c.env, firmId, found);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : "error");
    // Apple tries again later
    return c.json({ error: "server_error" }, 500);
  }
  return c.json({ ok: true });
});

// The plans whose period ends within a day, or ended, least recently checked first: asked of Apple again, so a lost
// notification is made up for. A few at a time with a short timeout, so a slow Apple cannot hold up the other timed steps.
export async function refreshApple(env: Env, now: number, limit = 5) {
  if (!configured(env)) return;
  const { results } = await env.CONTROL.prepare(
    `SELECT id, apple_original_transaction_id AS original FROM firms WHERE plan_source = 'apple' AND plan_status IN ('active', 'past_due')
     AND apple_original_transaction_id IS NOT NULL AND current_period_end < ? ORDER BY COALESCE(apple_checked_at, 0) LIMIT ?`,
  )
    .bind(now + DAY, limit)
    .all<{ id: string; original: string }>();
  for (const f of results) {
    try {
      // marked first, so a firm that keeps failing does not keep the others from their turn
      await env.CONTROL.prepare("UPDATE firms SET apple_checked_at = ? WHERE id = ?").bind(now, f.id).run();
      const found = await standing(env, f.original, 5_000);
      if (!found) await lose(env, f.id);
      else if (found.original === f.original && found.token === accountToken(f.id)) await apply(env, f.id, found);
    } catch (e) {
      console.error(e instanceof Error ? e.message : "error");
      itemFailed(classOf(e));
    }
  }
}

export const APPLE_MANAGE_URL = "https://apps.apple.com/account/subscriptions";
