import { Hono, type Context } from "hono";
import { audit } from "./audit";
import { isOwner } from "./firm";
import type { AppEnv, Firm } from "./session";
import { StripeError, stripe } from "./stripe";
import { DAY, MINUTE, sha256 } from "./util";

export const billing = new Hono<AppEnv>();

// Checkout refuses a trial end less than 48 hours away
const MIN_TRIAL_LEFT = 2 * DAY;

type Subscription = {
  id: string;
  customer: string | { id: string };
  status: string;
  cancel_at_period_end: boolean;
  cancel_at?: number | null;
  latest_invoice?: string | { id: string } | null;
  trial_end: number | null;
  current_period_end?: number;
  items?: { data: { current_period_end?: number }[] };
};

const idOf = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  const id = (v as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
};

function billingFailed(c: Context<AppEnv>, e: unknown) {
  console.error(e instanceof Error ? e.message : "error");
  return c.json({ error: "billing" }, 502);
}

async function customerOf(c: Context<AppEnv>, firm: Firm): Promise<string> {
  if (firm.stripe_customer_id) return firm.stripe_customer_id;
  const owner = await c.env.CONTROL.prepare("SELECT email FROM users WHERE id = ?").bind(c.get("session")!.userId).first<{ email: string }>();
  // the key repeats for the same details, so a retry after a lost answer finds the same customer
  const key = `customer-${firm.id}-${(await sha256(`${firm.name}\n${owner!.email}`)).slice(0, 12)}`;
  const created = await stripe<{ id: string }>(c.env, "POST", "/v1/customers", { name: firm.name, email: owner!.email, metadata: { firm_id: firm.id } }, key);
  await c.env.CONTROL.prepare("UPDATE firms SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(created.id, firm.id).run();
  const row = await c.env.CONTROL.prepare("SELECT stripe_customer_id FROM firms WHERE id = ?").bind(firm.id).first<{ stripe_customer_id: string }>();
  return row!.stripe_customer_id;
}

const GONE = new Set(["canceled", "incomplete_expired"]);

// Cancels what Stripe still has live instead of trusting our copy of the status.
export async function endSubscription(env: Env, id: string) {
  const path = `/v1/subscriptions/${encodeURIComponent(id)}`;
  const sub = await stripe<{ status: string }>(env, "GET", path).catch((e) => {
    if (e instanceof StripeError && e.status === 404) return null;
    throw e;
  });
  if (sub && !GONE.has(sub.status)) await stripe(env, "DELETE", path);
}

// A Checkout page left open could be paid after another one, so only one may stay open.
async function expireOpenSessions(env: Env, customer: string) {
  const open = await stripe<{ data: { id: string }[] }>(env, "GET", "/v1/checkout/sessions", { customer, status: "open", limit: 10 });
  for (const s of open.data) await stripe(env, "POST", `/v1/checkout/sessions/${encodeURIComponent(s.id)}/expire`);
}

// What a subscription charged is given back when we cancel it as a duplicate; a trial charged nothing.
async function cancelAndRefund(env: Env, sub: Subscription) {
  await stripe(env, "DELETE", `/v1/subscriptions/${encodeURIComponent(sub.id)}`);
  const invoice = idOf(sub.latest_invoice);
  if (sub.status === "trialing" || !invoice) return;
  const paid = await stripe<{ data: { status: string; payment?: { payment_intent?: string | null } }[] }>(env, "GET", "/v1/invoice_payments", { invoice });
  const intent = paid.data.find((p) => p.status === "paid")?.payment?.payment_intent;
  if (intent) await stripe(env, "POST", "/v1/refunds", { payment_intent: intent }, `refund-${intent}`);
}

billing.post("/billing/checkout", async (c) => {
  if (!(await isOwner(c))) return c.json({ error: "forbidden" }, 403);
  if (!c.env.STRIPE_PRICE_ID) return c.json({ error: "billing" }, 503);
  const firm = c.get("firm");
  const now = Date.now();
  // anyone with a live subscription changes it in the portal
  if (firm.plan_status === "active" || firm.plan_status === "past_due" || (firm.plan_status === "trialing" && firm.stripe_subscription_id)) {
    return c.json({ error: "subscribed" }, 409);
  }
  try {
    // a subscription left over from before is ended at Stripe too, whatever our status says
    if (firm.stripe_subscription_id) await endSubscription(c.env, firm.stripe_subscription_id);
    const customer = await customerOf(c, firm);
    await expireOpenSessions(c.env, customer);
    const session = await stripe<{ url: string | null }>(c.env, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      customer,
      client_reference_id: firm.id,
      line_items: [{ price: c.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${c.env.APP_URL}/settings?billing=done`,
      cancel_url: `${c.env.APP_URL}/settings?billing=cancel`,
      allow_promotion_codes: false,
      // TODO: add automatic_tax: { enabled: true } once there is a GST/HST registration and Stripe Tax is set up
      subscription_data: {
        metadata: { firm_id: firm.id },
        // an unused trial carries over, so the first charge is when it would have ended
        trial_end: firm.plan_status === "trialing" && firm.trial_ends_at && firm.trial_ends_at > now + MIN_TRIAL_LEFT ? Math.floor(firm.trial_ends_at / 1000) : undefined,
      },
    });
    if (!session.url) throw new Error("checkout session has no url");
    await audit(c, "billing.checkout", "firm", firm.id).run();
    return c.json({ url: session.url });
  } catch (e) {
    return billingFailed(c, e);
  }
});

billing.post("/billing/portal", async (c) => {
  if (!(await isOwner(c))) return c.json({ error: "forbidden" }, 403);
  const firm = c.get("firm");
  if (!firm.stripe_customer_id) return c.json({ error: "no_billing" }, 409);
  try {
    const session = await stripe<{ url: string }>(c.env, "POST", "/v1/billing_portal/sessions", {
      customer: firm.stripe_customer_id,
      return_url: `${c.env.APP_URL}/settings`,
    });
    return c.json({ url: session.url });
  } catch (e) {
    return billingFailed(c, e);
  }
});

const encoder = new TextEncoder();
const HEX = /^[0-9a-f]{64}$/i;

// Stripe-Signature is `t=<seconds>,v1=<hex>[,v1=<hex>...]`, an HMAC-SHA256 of `<t>.<raw body>`
export async function verifySignature(body: string, header: string | undefined, secret: string, now: number, tolerance = 5 * MINUTE): Promise<boolean> {
  if (!header) return false;
  let stamp = NaN;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const k = part.slice(0, at).trim();
    const v = part.slice(at + 1).trim();
    if (k === "t") stamp = Number(v);
    else if (k === "v1" && HEX.test(v)) sigs.push(v);
  }
  if (!Number.isFinite(stamp) || Math.abs(now - stamp * 1000) > tolerance) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const data = encoder.encode(`${stamp}.${body}`);
  let ok = false;
  // verify() compares in constant time; every signature is checked so timing doesn't say which one matched
  for (const sig of sigs) {
    const bytes = Uint8Array.from(sig.match(/../g)!, (h) => parseInt(h, 16));
    if (await crypto.subtle.verify("HMAC", key, bytes, data)) ok = true;
  }
  return ok;
}

const EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

type Plan = "trialing" | "active" | "past_due" | "canceled";

function planOf(status: string): Plan | null {
  switch (status) {
    case "trialing":
    case "active":
    case "past_due":
      return status;
    // payment problems, not endings: the same grace as a failed renewal, then access stops
    case "unpaid":
    case "paused":
      return "past_due";
    case "incomplete":
      return null;
    default:
      return "canceled";
  }
}

type Event = { id: string; type: string; data?: { object?: Record<string, any> } };

// The payload only says which firm and subscription to look at; the state itself is fetched.
async function sync(env: Env, event: Event) {
  const obj = event.data?.object ?? {};
  let customer: string | null;
  let subscription: string | null;
  let firmId: unknown;
  if (event.type === "checkout.session.completed") {
    if (obj.mode !== "subscription") return;
    customer = idOf(obj.customer);
    subscription = idOf(obj.subscription);
    firmId = obj.client_reference_id;
  } else if (event.type.startsWith("customer.subscription.")) {
    customer = idOf(obj.customer);
    subscription = idOf(obj.id);
    firmId = obj.metadata?.firm_id;
  } else {
    customer = idOf(obj.customer);
    subscription = idOf(obj.subscription) ?? idOf(obj.parent?.subscription_details?.subscription);
  }
  if (!customer || !subscription) return;

  type Row = { id: string; stripe_subscription_id: string | null; plan_status: string; closed_at: number | null };
  let firm = await env.CONTROL.prepare("SELECT id, stripe_subscription_id, plan_status, closed_at FROM firms WHERE stripe_customer_id = ?").bind(customer).first<Row>();
  // a firm that never saved its customer id (the save after creating it failed) is matched by what we put on the session
  if (!firm && typeof firmId === "string") {
    firm = await env.CONTROL.prepare("SELECT id, stripe_subscription_id, plan_status, closed_at FROM firms WHERE id = ? AND stripe_customer_id IS NULL").bind(firmId).first<Row>();
  }
  if (!firm) return;

  const sub = await stripe<Subscription>(env, "GET", `/v1/subscriptions/${encodeURIComponent(subscription)}`);
  if (idOf(sub.customer) !== customer) return;
  const plan = planOf(sub.status);
  if (!plan) return;
  // an ending counts only for the subscription we hold; a late or unknown one must not undo the current plan
  if (plan === "canceled" && firm.stripe_subscription_id !== sub.id) return;
  // a subscription must not outlive the account it was bought for, nor sit beside another live one
  const other = firm.stripe_subscription_id && firm.stripe_subscription_id !== sub.id && firm.plan_status !== "canceled";
  if (plan !== "canceled" && (firm.closed_at || other)) {
    await cancelAndRefund(env, sub);
    return;
  }
  const end = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
  await env.CONTROL.prepare(
    `UPDATE firms SET stripe_customer_id = ?, stripe_subscription_id = ?, plan_status = ?, current_period_end = ?, cancel_at_period_end = ?,
       past_due_since = CASE WHEN ? = 'past_due' THEN COALESCE(past_due_since, ?) ELSE NULL END,
       trial_ends_at = CASE WHEN ? = 'trialing' AND ? IS NOT NULL THEN ? ELSE trial_ends_at END WHERE id = ?`,
  )
    .bind(customer, sub.id, plan, end ? end * 1000 : null, sub.cancel_at_period_end || sub.cancel_at != null ? 1 : 0, plan, Date.now(), plan, sub.trial_end, sub.trial_end ? sub.trial_end * 1000 : null, firm.id)
    .run();
}

export const stripeWebhook = new Hono<AppEnv>();

stripeWebhook.post("/stripe/webhook", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  const raw = await c.req.text();
  if (!(await verifySignature(raw, c.req.header("Stripe-Signature"), c.env.STRIPE_WEBHOOK_SECRET, Date.now()))) {
    return c.json({ error: "invalid" }, 400);
  }
  let event: Event;
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid" }, 400);
  }
  if (typeof event?.id !== "string" || typeof event.type !== "string") return c.json({ error: "invalid" }, 400);
  if (!EVENTS.has(event.type)) return c.json({ ok: true });
  if (await c.env.CONTROL.prepare("SELECT 1 FROM stripe_events WHERE id = ?").bind(event.id).first()) return c.json({ ok: true });
  try {
    await sync(c.env, event);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "error");
    return c.json({ error: "server_error" }, 500);
  }
  // recorded only once it worked, so a killed Worker means a retry; syncing twice is harmless
  await c.env.CONTROL.prepare("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)").bind(event.id, event.type, Date.now()).run();
  return c.json({ ok: true });
});
