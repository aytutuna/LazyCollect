import "reflect-metadata";
import { X509Certificate, X509ChainBuilder } from "@peculiar/x509";
import { Hono } from "hono";
import { audit } from "./audit";
import { isOwner } from "./firm";
import type { AppEnv } from "./session";
import { FETCH_TIMEOUT_MS } from "./util";
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
    const root = new X509Certificate(env.APPLE_IAP_ROOT ?? APPLE_ROOT_G3);
    if (!top.equal(root) || !leaf.getExtension(LEAF_OID) || !intermediate.getExtension(INTERMEDIATE_OID)) return null;
    const chain = await new X509ChainBuilder({ certificates: [intermediate, root] }).build(leaf);
    if (chain.length !== 3 || !chain[2].equal(root)) return null;
    const key = await crypto.subtle.importKey("spki", leaf.publicKey.rawData, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const signed = encoder.encode(`${parts[0]}.${parts[1]}`);
    return (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64url(parts[2]), signed)) ? json(parts[1]) : null;
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
async function appleGet(env: Env, path: string): Promise<any | null> {
  // sandbox purchases are free, so the live Worker looks there only while APPLE_IAP_SANDBOX is on (App Review, TestFlight)
  const bases = env.APPLE_API_BASE ? [env.APPLE_API_BASE] : env.APPLE_IAP_SANDBOX === "1" ? [PRODUCTION, SANDBOX] : [PRODUCTION];
  const token = await apiToken(env);
  for (const base of bases) {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
export async function standing(env: Env, transactionId: string): Promise<Standing | null> {
  const body = await appleGet(env, `/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`);
  for (const group of body?.data ?? []) {
    for (const last of group.lastTransactions ?? []) {
      const tx = await verifyJws(env, last.signedTransactionInfo);
      if (!tx || tx.bundleId !== BUNDLE_ID || tx.productId !== PLAN_PRODUCT || typeof tx.originalTransactionId !== "string") continue;
      if (tx.environment === "Sandbox" && env.APPLE_IAP_SANDBOX !== "1") continue;
      const renewal = last.signedRenewalInfo ? await verifyJws(env, last.signedRenewalInfo) : null;
      // 1 active, 2 expired, 3 in billing retry, 4 in the billing grace period, 5 revoked
      const plan = last.status === 1 || last.status === 4 ? "active" : last.status === 3 ? "past_due" : "canceled";
      return {
        original: tx.originalTransactionId,
        plan: tx.revocationDate ? "canceled" : plan,
        periodEnd: Number(tx.expiresDate) || 0,
        renews: renewal?.autoRenewStatus === 1,
        token: typeof tx.appAccountToken === "string" ? tx.appAccountToken.toLowerCase() : null,
      };
    }
  }
  return null;
}

// the account token the app puts on the purchase: the firm's id as a UUID, so a transaction can't be attached to another firm
export const accountToken = (firmId: string) => firmId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

async function apply(env: Env, firmId: string, s: Standing) {
  const now = Date.now();
  await env.CONTROL.prepare(
    `UPDATE firms SET plan_source = 'apple', apple_original_transaction_id = ?, plan_status = ?, current_period_end = ?, cancel_at_period_end = ?,
       past_due_since = CASE WHEN ? = 'past_due' THEN COALESCE(past_due_since, ?) ELSE NULL END WHERE id = ?`,
  )
    .bind(s.original, s.plan, s.periodEnd || null, s.renews ? 0 : 1, s.plan, now, firmId)
    .run();
}

export const appleBilling = new Hono<AppEnv>();

appleBilling.post("/billing/apple", async (c) => {
  if (!(await isOwner(c))) return c.json({ error: "forbidden" }, 403);
  if (!configured(c.env)) return c.json({ error: "unavailable" }, 503);
  const body = await readBody(c);
  if (typeof body?.transaction_id !== "string" || !/^\d{1,20}$/.test(body.transaction_id)) return invalid(c);
  const firm = c.get("firm");
  // one subscription per account: a plan bought on the web is changed there
  if (firm.stripe_subscription_id && (firm.plan_status === "active" || firm.plan_status === "past_due")) return c.json({ error: "subscribed" }, 409);
  let found: Standing | null;
  try {
    found = await standing(c.env, body.transaction_id);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "error");
    return c.json({ error: "billing" }, 502);
  }
  if (!found) return notFound(c);
  if (found.token !== accountToken(firm.id)) return c.json({ error: "other_account" }, 409);
  const used = await c.env.CONTROL.prepare("SELECT 1 FROM firms WHERE apple_original_transaction_id = ? AND id != ?").bind(found.original, firm.id).first();
  if (used) return c.json({ error: "in_use" }, 409);
  await apply(c.env, firm.id, found);
  await audit(c, "billing.apple", "firm", firm.id).run();
  return c.json({ ok: true, plan_status: found.plan });
});

export const appleWebhook = new Hono<AppEnv>();

// App Store Server Notifications V2. The signed payload says which transaction changed; the state is asked of Apple again.
appleWebhook.post("/apple/notifications", async (c) => {
  if (!configured(c.env)) return c.json({ error: "unavailable" }, 503);
  const raw = await c.req.text();
  if (raw.length > MAX_BODY) return c.json({ error: "too_big" }, 413);
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
  const firm = await c.env.CONTROL.prepare("SELECT id FROM firms WHERE apple_original_transaction_id = ?").bind(tx.originalTransactionId).first<{ id: string }>();
  if (!firm) return c.json({ ok: true });
  try {
    const found = await standing(c.env, tx.transactionId);
    if (found && found.original === tx.originalTransactionId) await apply(c.env, firm.id, found);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "error");
    // Apple tries again later
    return c.json({ error: "server_error" }, 500);
  }
  return c.json({ ok: true });
});

