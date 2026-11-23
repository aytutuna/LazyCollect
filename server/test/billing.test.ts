import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { verifySignature } from "../src/billing";
import { DAY } from "../src/util";
import { addMember, api, firmRow, login, mockOutbound, openRequest, pdf, upload } from "./helpers";
import { stripeFake } from "./stripe-fake";

async function owner(email = "owner@firm.test", name = "Tuna Tax") {
  const cookie = await login(email);
  await api("/api/firm", { method: "PATCH", cookie, body: { name } });
  return cookie;
}

const sessions = () => stripeFake.calls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions");
const checkout = (cookie: string) => api("/api/billing/checkout", { method: "POST", cookie });

async function sign(body: string, secret = "whsec_test", at = Date.now()) {
  const stamp = Math.floor(at / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${stamp}.${body}`));
  return `t=${stamp},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function webhook(event: object, header?: string | null) {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (header !== null) headers["stripe-signature"] = header ?? (await sign(body));
  // no cookie and no X-Collect header, like Stripe's own calls
  return exports.default.fetch("https://collect.alazy.app/api/stripe/webhook", { method: "POST", headers, body });
}

async function subscribed(email = "owner@firm.test") {
  const cookie = await owner(email);
  mockOutbound();
  await checkout(cookie);
  const firm = await firmRow(cookie);
  return { cookie, firm, customer: firm.stripe_customer_id as string };
}

describe("checkout", () => {
  it("creates a customer and a subscription session for the owner", async () => {
    const cookie = await owner();
    mockOutbound();
    const res = await checkout(cookie);
    expect(res.status).toBe(200);
    const { url } = await res.json<any>();
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.test\//);

    const cus = stripeFake.calls.find((c) => c.path === "/v1/customers")!;
    const [session] = sessions();
    expect(cus.path).toBe("/v1/customers");
    expect(cus.form).toMatchObject({ name: "Tuna Tax", email: "owner@firm.test" });
    const firm = await firmRow(cookie);
    expect(cus.form["metadata[firm_id]"]).toBe(firm.id);
    expect(Object.keys(cus.form).filter((k) => k.startsWith("metadata"))).toEqual(["metadata[firm_id]"]);
    expect(firm.stripe_customer_id).toBe("cus_1");

    expect(session.form).toMatchObject({
      mode: "subscription",
      customer: "cus_1",
      client_reference_id: firm.id,
      "line_items[0][price]": "price_test",
      "line_items[0][quantity]": "1",
      success_url: "https://collect.alazy.app/settings?billing=done",
      cancel_url: "https://collect.alazy.app/settings?billing=cancel",
      allow_promotion_codes: "false",
    });
    expect(session.form["automatic_tax[enabled]"]).toBeUndefined();
    for (const call of stripeFake.calls.filter((c) => c.method === "POST")) {
      expect(call.headers.get("stripe-version")).toMatch(/^\d{4}-\d\d-\d\d\./);
      expect(call.headers.get("idempotency-key")).toBeTruthy();
    }
  });

  it("starts billing when the trial would have ended", async () => {
    const cookie = await owner();
    mockOutbound();
    await checkout(cookie);
    const firm = await firmRow(cookie);
    expect(sessions()[0].form["subscription_data[trial_end]"]).toBe(String(Math.floor(firm.trial_ends_at / 1000)));
    expect(sessions()[0].form["subscription_data[metadata][firm_id]"]).toBe(firm.id);
  });

  it("bills at once when the trial is nearly over or already ended", async () => {
    const cookie = await owner();
    mockOutbound();
    await env.CONTROL.prepare("UPDATE firms SET trial_ends_at = ?").bind(Date.now() + DAY).run();
    await checkout(cookie);
    expect(sessions()[0].form["subscription_data[trial_end]"]).toBeUndefined();
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'canceled'").run();
    await checkout(cookie);
    expect(sessions().at(-1)!.form["subscription_data[trial_end]"]).toBeUndefined();
  });

  it("reuses the customer", async () => {
    const cookie = await owner();
    mockOutbound();
    await checkout(cookie);
    await checkout(cookie);
    expect(stripeFake.calls.filter((c) => c.path === "/v1/customers")).toHaveLength(1);
    expect(sessions()).toHaveLength(2);
  });

  it("is for the owner only", async () => {
    const cookie = await owner();
    const member = await addMember(cookie);
    mockOutbound();
    expect((await checkout(member)).status).toBe(403);
    expect((await api("/api/billing/checkout", { method: "POST" })).status).toBe(401);
    expect(stripeFake.calls).toHaveLength(0);
  });

  it("refuses an account that is already subscribed", async () => {
    const cookie = await owner();
    mockOutbound();
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    expect((await checkout(cookie)).status).toBe(409);
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'trialing', stripe_subscription_id = 'sub_1'").run();
    expect((await checkout(cookie)).status).toBe(409);
  });

  it("answers 502 when Stripe fails", async () => {
    const cookie = await owner();
    mockOutbound();
    stripeFake.failing = true;
    expect((await checkout(cookie)).status).toBe(502);
    expect((await firmRow(cookie)).stripe_customer_id).toBeNull();
  });
});

describe("portal", () => {
  it("opens the portal for the owner's customer", async () => {
    const cookie = await owner();
    mockOutbound();
    await checkout(cookie);
    const res = await api("/api/billing/portal", { method: "POST", cookie });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).url).toMatch(/^https:\/\/portal\.stripe\.test\//);
    const call = stripeFake.calls.at(-1)!;
    expect(call.form).toMatchObject({ customer: "cus_1", return_url: "https://collect.alazy.app/settings" });
    expect(call.headers.get("idempotency-key")).toBeTruthy();
  });

  it("needs a customer first, and the owner", async () => {
    const cookie = await owner();
    const member = await addMember(cookie);
    mockOutbound();
    expect((await api("/api/billing/portal", { method: "POST", cookie })).status).toBe(409);
    expect((await api("/api/billing/portal", { method: "POST", cookie: member })).status).toBe(403);
  });
});

describe("tenant isolation", () => {
  it("keeps each firm's customer and plan to itself", async () => {
    const a = await owner("a@firm.test", "Firm A");
    const b = await owner("b@firm.test", "Firm B");
    mockOutbound();
    await checkout(a);
    await checkout(b);
    expect((await firmRow(a)).stripe_customer_id).toBe("cus_1");
    expect((await firmRow(b)).stripe_customer_id).toBe("cus_3");
    await api("/api/billing/portal", { method: "POST", cookie: b });
    expect(stripeFake.calls.at(-1)!.form.customer).toBe("cus_3");

    // an event about firm A's customer leaves firm B alone
    stripeFake.sub("sub_a", "cus_1", { status: "active" });
    await webhook({ id: "evt_a", type: "customer.subscription.updated", data: { object: { id: "sub_a", customer: "cus_1" } } });
    expect((await firmRow(a)).plan_status).toBe("active");
    expect((await firmRow(b)).plan_status).toBe("trialing");
    expect((await firmRow(b)).stripe_subscription_id).toBeNull();
  });
});

describe("signature", () => {
  const body = '{"id":"evt_1"}';
  const secret = "whsec_test";
  const now = Date.now();

  it("accepts a good signature", async () => {
    expect(await verifySignature(body, await sign(body, secret, now), secret, now)).toBe(true);
  });

  it("rejects a wrong secret, a changed body and a missing or malformed header", async () => {
    expect(await verifySignature(body, await sign(body, "whsec_other", now), secret, now)).toBe(false);
    expect(await verifySignature(`${body} `, await sign(body, secret, now), secret, now)).toBe(false);
    expect(await verifySignature(body, undefined, secret, now)).toBe(false);
    expect(await verifySignature(body, "garbage", secret, now)).toBe(false);
    expect(await verifySignature(body, `t=${Math.floor(now / 1000)},v1=zz`, secret, now)).toBe(false);
    expect(await verifySignature(body, `v1=${(await sign(body, secret, now)).split("v1=")[1]}`, secret, now)).toBe(false);
  });

  it("rejects a timestamp more than five minutes off", async () => {
    expect(await verifySignature(body, await sign(body, secret, now - 301_000), secret, now)).toBe(false);
    expect(await verifySignature(body, await sign(body, secret, now - 299_000), secret, now)).toBe(true);
    expect(await verifySignature(body, await sign(body, secret, now + 301_000), secret, now)).toBe(false);
  });

  it("accepts when any of several v1 signatures matches", async () => {
    const good = await sign(body, secret, now);
    const stale = await sign(body, "whsec_old", now);
    const stamp = good.split(",")[0];
    const v1 = (s: string) => s.split(",")[1];
    expect(await verifySignature(body, `${stamp},${v1(stale)},${v1(good)}`, secret, now)).toBe(true);
    expect(await verifySignature(body, `${stamp},${v1(good)},${v1(stale)}`, secret, now)).toBe(true);
    expect(await verifySignature(body, `${stamp},${v1(stale)},v1=${"0".repeat(64)}`, secret, now)).toBe(false);
  });

  it("looks only at the first three v1 signatures", async () => {
    const good = await sign(body, secret, now);
    const [stamp, v1] = good.split(",");
    const junk = `v1=${"0".repeat(64)}`;
    expect(await verifySignature(body, `${stamp},${junk},${junk},${v1}`, secret, now)).toBe(true);
    expect(await verifySignature(body, `${stamp},${junk},${junk},${junk},${v1}`, secret, now)).toBe(false);
  });
});

describe("webhook", () => {
  it("refuses a body over 512 KB before looking at the signature", async () => {
    const event = { id: "evt_big", type: "invoice.paid", pad: "x".repeat(513 * 1024) };
    expect((await webhook(event)).status).toBe(413);
    expect((await env.CONTROL.prepare("SELECT COUNT(*) AS n FROM stripe_events").first<any>()).n).toBe(0);
  });

  it("rejects calls without a valid signature", async () => {
    const event = { id: "evt_1", type: "invoice.paid", data: { object: {} } };
    expect((await webhook(event, null)).status).toBe(400);
    expect((await webhook(event, await sign(JSON.stringify(event), "whsec_other"))).status).toBe(400);
    expect((await webhook(event, await sign(JSON.stringify(event), "whsec_test", Date.now() - 600_000))).status).toBe(400);
    expect((await env.CONTROL.prepare("SELECT COUNT(*) AS n FROM stripe_events").first<any>()).n).toBe(0);
  });

  it("rejects a signed body that is not an event", async () => {
    const body = "not json";
    const res = await exports.default.fetch("https://collect.alazy.app/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": await sign(body) }, body });
    expect(res.status).toBe(400);
  });

  it("handles each event type by fetching the subscription", async () => {
    const { cookie, customer } = await subscribed();
    const end = Date.now() + 20 * DAY;
    const cases: [string, any, string][] = [
      ["checkout.session.completed", { mode: "subscription", customer, subscription: "sub_1" }, "active"],
      ["customer.subscription.created", { id: "sub_1", customer }, "active"],
      ["customer.subscription.updated", { id: "sub_1", customer }, "past_due"],
      ["invoice.payment_failed", { customer, subscription: "sub_1" }, "past_due"],
      ["invoice.paid", { customer, parent: { subscription_details: { subscription: "sub_1" } } }, "active"],
      ["customer.subscription.deleted", { id: "sub_1", customer }, "canceled"],
    ];
    for (const [i, [type, object, status]] of cases.entries()) {
      const cancelling = type === "invoice.paid";
      stripeFake.sub("sub_1", customer, { status, end, cancel_at_period_end: cancelling });
      const res = await webhook({ id: `evt_${i}`, type, data: { object } });
      expect(res.status).toBe(200);
      const firm = await firmRow(cookie);
      expect(firm).toMatchObject({ plan_status: status, stripe_subscription_id: "sub_1", cancel_at_period_end: cancelling ? 1 : 0 });
      expect(firm.current_period_end).toBe(Math.floor(end / 1000) * 1000);
    }
  });

  it("counts the grace from the first failure only", async () => {
    const { cookie, customer } = await subscribed();
    stripeFake.sub("sub_1", customer, { status: "past_due" });
    await webhook({ id: "evt_1", type: "invoice.payment_failed", data: { object: { customer, subscription: "sub_1" } } });
    const first = (await firmRow(cookie)).past_due_since;
    expect(first).toBeGreaterThan(0);
    await env.CONTROL.prepare("UPDATE firms SET past_due_since = ?").bind(first - 1000).run();
    await webhook({ id: "evt_2", type: "invoice.payment_failed", data: { object: { customer, subscription: "sub_1" } } });
    expect((await firmRow(cookie)).past_due_since).toBe(first - 1000);
    stripeFake.sub("sub_1", customer, { status: "active" });
    await webhook({ id: "evt_3", type: "invoice.paid", data: { object: { customer, subscription: "sub_1" } } });
    expect((await firmRow(cookie)).past_due_since).toBeNull();
  });

  it("cancels a subscription that completes after the account was closed", async () => {
    const { cookie, customer } = await subscribed();
    await env.CONTROL.prepare("UPDATE firms SET closed_at = 5").run();
    stripeFake.sub("sub_1", customer);
    await webhook({ id: "evt_1", type: "checkout.session.completed", data: { object: { mode: "subscription", customer, subscription: "sub_1" } } });
    expect(stripeFake.subs.get("sub_1")!.status).toBe("canceled");
    expect((await firmRow(cookie)).stripe_subscription_id).toBeNull();
  });

  it("cancels a second live subscription", async () => {
    const { cookie, customer } = await subscribed();
    stripeFake.sub("sub_1", customer);
    await webhook({ id: "evt_1", type: "customer.subscription.created", data: { object: { id: "sub_1", customer } } });
    stripeFake.sub("sub_2", customer);
    await webhook({ id: "evt_2", type: "customer.subscription.created", data: { object: { id: "sub_2", customer } } });
    expect(stripeFake.subs.get("sub_2")!.status).toBe("canceled");
    expect((await firmRow(cookie)).stripe_subscription_id).toBe("sub_1");
  });

  it("does not trust the payload's own status", async () => {
    const { cookie, customer } = await subscribed();
    stripeFake.sub("sub_1", customer, { status: "past_due" });
    await webhook({ id: "evt_1", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer, status: "active" } } });
    expect((await firmRow(cookie)).plan_status).toBe("past_due");
  });

  it("keeps a trial running when the subscription is still trialing", async () => {
    const { cookie, customer } = await subscribed();
    const trialEnd = Math.floor((Date.now() + 9 * DAY) / 1000);
    stripeFake.sub("sub_1", customer, { status: "trialing", trial_end: trialEnd, end: trialEnd * 1000 });
    await webhook({ id: "evt_1", type: "customer.subscription.created", data: { object: { id: "sub_1", customer } } });
    expect(await firmRow(cookie)).toMatchObject({ plan_status: "trialing", trial_ends_at: trialEnd * 1000, stripe_subscription_id: "sub_1" });
  });

  it("processes an event id once", async () => {
    const { cookie, customer } = await subscribed();
    stripeFake.sub("sub_1", customer);
    const event = { id: "evt_same", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer } } };
    expect((await webhook(event)).status).toBe(200);
    const fetched = () => stripeFake.calls.filter((c) => c.method === "GET" && c.path.startsWith("/v1/subscriptions/")).length;
    expect(fetched()).toBe(1);
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'canceled'").run();
    expect((await webhook(event)).status).toBe(200);
    expect(fetched()).toBe(1);
    expect((await firmRow(cookie)).plan_status).toBe("canceled");
  });

  it("records an event only after it was processed", async () => {
    const { customer } = await subscribed();
    stripeFake.sub("sub_1", customer);
    const event = { id: "evt_rec", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer } } };
    const recorded = async () => (await env.CONTROL.prepare("SELECT COUNT(*) AS n FROM stripe_events WHERE id = 'evt_rec'").first<any>()).n;
    stripeFake.failing = true;
    expect((await webhook(event)).status).toBe(500);
    expect(await recorded()).toBe(0);
    stripeFake.failing = false;
    expect((await webhook(event)).status).toBe(200);
    expect(await recorded()).toBe(1);
  });

  it("lets Stripe retry when fetching the subscription fails", async () => {
    const { cookie, customer } = await subscribed();
    stripeFake.sub("sub_1", customer);
    const event = { id: "evt_retry", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer } } };
    stripeFake.failing = true;
    expect((await webhook(event)).status).toBe(500);
    stripeFake.failing = false;
    expect((await webhook(event)).status).toBe(200);
    expect((await firmRow(cookie)).plan_status).toBe("active");
  });

  it("ignores unknown customers and events it does not handle", async () => {
    const { cookie } = await subscribed();
    stripeFake.sub("sub_9", "cus_other");
    const before = stripeFake.calls.length;
    expect((await webhook({ id: "evt_1", type: "customer.subscription.updated", data: { object: { id: "sub_9", customer: "cus_other" } } })).status).toBe(200);
    expect((await webhook({ id: "evt_2", type: "charge.refunded", data: { object: {} } })).status).toBe(200);
    expect(stripeFake.calls.length).toBe(before);
    expect((await firmRow(cookie)).stripe_subscription_id).toBeNull();
  });

  it("finds the account by client_reference_id when the customer was not saved", async () => {
    const cookie = await owner();
    mockOutbound();
    const firm = await firmRow(cookie);
    stripeFake.sub("sub_1", "cus_lost");
    await webhook({ id: "evt_1", type: "checkout.session.completed", data: { object: { mode: "subscription", customer: "cus_lost", subscription: "sub_1", client_reference_id: firm.id } } });
    expect(await firmRow(cookie)).toMatchObject({ stripe_customer_id: "cus_lost", stripe_subscription_id: "sub_1", plan_status: "active" });
  });

  it("does not let a late event for an old subscription undo a new one", async () => {
    const { cookie, customer } = await subscribed();
    stripeFake.sub("sub_new", customer);
    await webhook({ id: "evt_1", type: "customer.subscription.created", data: { object: { id: "sub_new", customer } } });
    stripeFake.sub("sub_old", customer, { status: "canceled" });
    await webhook({ id: "evt_2", type: "customer.subscription.deleted", data: { object: { id: "sub_old", customer } } });
    expect(await firmRow(cookie)).toMatchObject({ plan_status: "active", stripe_subscription_id: "sub_new" });
  });

  it("takes a new subscription after an ended one", async () => {
    const { cookie, customer } = await subscribed();
    stripeFake.sub("sub_old", customer);
    await webhook({ id: "evt_0", type: "customer.subscription.created", data: { object: { id: "sub_old", customer } } });
    stripeFake.sub("sub_old", customer, { status: "canceled" });
    await webhook({ id: "evt_1", type: "customer.subscription.deleted", data: { object: { id: "sub_old", customer } } });
    expect((await firmRow(cookie)).plan_status).toBe("canceled");
    stripeFake.sub("sub_new", customer);
    await webhook({ id: "evt_2", type: "customer.subscription.created", data: { object: { id: "sub_new", customer } } });
    expect(await firmRow(cookie)).toMatchObject({ plan_status: "active", stripe_subscription_id: "sub_new" });
  });

  it("leaves the plan alone while a payment is incomplete", async () => {
    const { cookie, customer } = await subscribed();
    stripeFake.sub("sub_1", customer, { status: "incomplete" });
    await webhook({ id: "evt_1", type: "customer.subscription.created", data: { object: { id: "sub_1", customer } } });
    expect(await firmRow(cookie)).toMatchObject({ plan_status: "trialing", stripe_subscription_id: null });
  });
});

describe("a lapsed plan", () => {
  it("still lets the firm read, download and export what it holds", async () => {
    const { cookie, req, path } = await openRequest();
    await upload(path, req.items[0].id, pdf(500));
    const files = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'canceled', trial_ends_at = 1").run();
    expect((await api("/api/requests", { cookie })).status).toBe(200);
    expect((await api(`/api/requests/${req.id}`, { cookie })).status).toBe(200);
    expect((await api(`/api/files/${files.items[0].files[0].id}`, { cookie })).status).toBe(200);
    expect((await api(`/api/requests/${req.id}/export`, { cookie })).status).toBe(200);
  });
});

describe("double payment", () => {
  it("expires an open checkout page before making a new one", async () => {
    const cookie = await owner();
    mockOutbound();
    await checkout(cookie);
    await checkout(cookie);
    expect([...stripeFake.sessions.values()].map((s) => s.status)).toEqual(["expired", "open"]);
  });

  async function twoSubs(secondStatus: string, trial: number | null = null) {
    const { cookie, customer } = await subscribed();
    stripeFake.sub("sub_1", customer);
    await webhook({ id: "evt_1", type: "customer.subscription.created", data: { object: { id: "sub_1", customer } } });
    stripeFake.sub("sub_2", customer, { status: secondStatus, trial_end: trial, latest_invoice: "in_2" });
    stripeFake.payments.set("in_2", [
      { status: "open", payment: { payment_intent: "pi_other" } },
      { status: "paid", payment: { payment_intent: "pi_2" } },
    ]);
    await webhook({ id: "evt_2", type: "customer.subscription.created", data: { object: { id: "sub_2", customer } } });
    return { cookie, customer };
  }

  const refunds = () => stripeFake.calls.filter((c) => c.path === "/v1/refunds");

  it("cancels a second subscription and refunds what it charged", async () => {
    const { cookie } = await twoSubs("active");
    expect(stripeFake.subs.get("sub_2")!.status).toBe("canceled");
    expect(refunds()).toHaveLength(1);
    expect(refunds()[0].form).toEqual({ payment_intent: "pi_2" });
    expect(refunds()[0].headers.get("idempotency-key")).toBe("refund-pi_2");
    expect((await firmRow(cookie)).stripe_subscription_id).toBe("sub_1");
  });

  it("keeps the duplicate alive when the refund fails, and finishes on the retry", async () => {
    const { customer } = await subscribed();
    stripeFake.sub("sub_1", customer);
    await webhook({ id: "evt_1", type: "customer.subscription.created", data: { object: { id: "sub_1", customer } } });
    stripeFake.sub("sub_2", customer, { latest_invoice: "in_2" });
    stripeFake.payments.set("in_2", [{ status: "paid", payment: { payment_intent: "pi_2" } }]);
    const event = { id: "evt_2", type: "customer.subscription.created", data: { object: { id: "sub_2", customer } } };
    stripeFake.refund = "fail";
    expect((await webhook(event)).status).toBe(500);
    expect(stripeFake.subs.get("sub_2")!.status).toBe("active");
    stripeFake.refund = "ok";
    expect((await webhook(event)).status).toBe(200);
    expect(stripeFake.subs.get("sub_2")!.status).toBe("canceled");
  });

  it("treats a charge that is already refunded as done", async () => {
    stripeFake.refund = "already";
    await twoSubs("active");
    expect(stripeFake.subs.get("sub_2")!.status).toBe("canceled");
  });

  it("refunds nothing for a trial", async () => {
    await twoSubs("trialing", Math.floor(Date.now() / 1000) + 86_400);
    expect(stripeFake.subs.get("sub_2")!.status).toBe("canceled");
    expect(refunds()).toHaveLength(0);
  });

  it("refunds a subscription paid after the account was closed", async () => {
    const { customer } = await subscribed();
    await env.CONTROL.prepare("UPDATE firms SET closed_at = 5").run();
    stripeFake.sub("sub_9", customer, { latest_invoice: "in_9" });
    stripeFake.payments.set("in_9", [{ status: "paid", payment: { payment_intent: "pi_9" } }]);
    await webhook({ id: "evt_9", type: "checkout.session.completed", data: { object: { mode: "subscription", customer, subscription: "sub_9" } } });
    expect(stripeFake.subs.get("sub_9")!.status).toBe("canceled");
    expect(refunds()[0].form.payment_intent).toBe("pi_9");
  });

  it("ends a leftover subscription that Stripe still has live when subscribing again", async () => {
    const { cookie, customer } = await subscribed();
    stripeFake.sub("sub_old", customer, { status: "past_due" });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'canceled', stripe_subscription_id = 'sub_old'").run();
    expect((await checkout(cookie)).status).toBe(200);
    expect(stripeFake.subs.get("sub_old")!.status).toBe("canceled");
  });
});

describe("plan mapping", () => {
  it("ignores an ending for a subscription the firm does not hold", async () => {
    const { cookie, customer } = await subscribed();
    stripeFake.sub("sub_x", customer, { status: "canceled" });
    await webhook({ id: "evt_1", type: "customer.subscription.deleted", data: { object: { id: "sub_x", customer } } });
    expect(await firmRow(cookie)).toMatchObject({ plan_status: "trialing", stripe_subscription_id: null });
  });

  it("treats unpaid and paused as a payment problem", async () => {
    const { cookie, customer } = await subscribed();
    for (const [i, status] of ["unpaid", "paused"].entries()) {
      stripeFake.sub("sub_1", customer, { status });
      await webhook({ id: `evt_${i}`, type: "customer.subscription.updated", data: { object: { id: "sub_1", customer } } });
      expect(await firmRow(cookie)).toMatchObject({ plan_status: "past_due" });
      expect((await firmRow(cookie)).past_due_since).toBeGreaterThan(0);
    }
  });

  it("counts a set cancellation date as a cancellation", async () => {
    const { cookie, customer } = await subscribed();
    stripeFake.sub("sub_1", customer, { cancel_at: Math.floor(Date.now() / 1000) + DAY });
    await webhook({ id: "evt_1", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer } } });
    expect((await firmRow(cookie)).cancel_at_period_end).toBe(1);
  });
});
