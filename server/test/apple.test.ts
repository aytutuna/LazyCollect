import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { accountToken } from "../src/apple";
import { AppleCa, appleFake } from "./apple-fake";
import { api, firmRow, login, mockOutbound } from "./helpers";

let ca: AppleCa;

beforeEach(async () => {
  ca = await AppleCa.create();
  appleFake.ca = ca;
  env.APPLE_IAP_ROOT = ca.rootPem;
  mockOutbound();
});

async function owner(email = "owner@firm.test") {
  const cookie = await login(email);
  await api("/api/firm", { method: "PATCH", cookie, body: { name: "Tuna Tax" } });
  const firm = await firmRow(cookie);
  return { cookie, firm, token: accountToken(firm.id) };
}

const buy = (cookie: string, transaction_id = "2000000000001") => api("/api/billing/apple", { method: "POST", cookie, body: { transaction_id } });

async function notify(payload: string | undefined, raw?: string) {
  return exports.default.fetch("https://collect.alazy.app/api/apple/notifications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify({ signedPayload: payload }),
  });
}

describe("buying the plan in the app", () => {
  it("is unavailable until Apple's key is set", async () => {
    const { cookie } = await owner();
    const saved = env.APPLE_IAP_KEY;
    env.APPLE_IAP_KEY = undefined;
    try {
      expect((await buy(cookie)).status).toBe(503);
      expect((await notify("x")).status).toBe(503);
    } finally {
      env.APPLE_IAP_KEY = saved;
    }
  });

  it("makes the plan active from what Apple says, for the firm the purchase was made for", async () => {
    const { cookie, token } = await owner();
    const expires = Date.now() + 30 * 86_400_000;
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token, expires };
    const res = await buy(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, plan_status: "active" });
    const firm = await firmRow(cookie);
    expect(firm).toMatchObject({ plan_source: "apple", apple_original_transaction_id: "1000000000001", plan_status: "active", current_period_end: expires, cancel_at_period_end: 0 });
    const me = await (await api("/api/me", { cookie })).json<any>();
    expect(me.firm).toMatchObject({ plan_source: "apple", usable: true });
    const call = appleFake.calls[0];
    expect(call.url).toBe("https://apple.test/inApps/v1/subscriptions/2000000000001");
    expect(call.auth?.split(".")).toHaveLength(3);
  });

  it("notes a plan that will not renew", async () => {
    const { cookie, token } = await owner();
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token, renews: false };
    await buy(cookie);
    expect((await firmRow(cookie)).cancel_at_period_end).toBe(1);
  });

  it("refuses a purchase made for another firm's account", async () => {
    const { cookie } = await owner();
    const other = await owner("other@firm.test");
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token: other.token };
    expect((await buy(cookie)).status).toBe(409);
    appleFake.subs["2000000000002"] = { status: 1, original: "1000000000002", token: null };
    expect((await buy(cookie, "2000000000002")).status).toBe(409);
    expect((await firmRow(cookie)).plan_source).toBeNull();
  });

  it("refuses a subscription another firm already holds", async () => {
    const first = await owner();
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token: first.token };
    expect((await buy(first.cookie)).status).toBe(200);
    const second = await owner("second@firm.test");
    appleFake.subs["2000000000002"] = { status: 1, original: "1000000000001", token: second.token };
    expect((await buy(second.cookie, "2000000000002")).status).toBe(409);
  });

  it("does not take a transaction Apple does not know, or one for another product or app", async () => {
    const { cookie, token } = await owner();
    expect((await buy(cookie, "2000000000009")).status).toBe(404);
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token, product: "com.other.plan" };
    expect((await buy(cookie)).status).toBe(404);
    expect((await firmRow(cookie)).plan_status).toBe("trialing");
  });

  it("does not take a transaction that was not signed by Apple's chain", async () => {
    const { cookie, token } = await owner();
    appleFake.ca = await AppleCa.create();
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token };
    expect((await buy(cookie)).status).toBe(404);
  });

  it("does not take a certificate Apple's root signed but that lacks the marks of the receipt signing ones", async () => {
    const { cookie, token } = await owner();
    for (const marks of [{ leaf: false }, { intermediate: false }]) {
      appleFake.ca = ca = await AppleCa.create(marks);
      env.APPLE_IAP_ROOT = ca.rootPem;
      appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token };
      expect((await buy(cookie)).status).toBe(404);
    }
  });

  it("takes sandbox purchases only while that is switched on", async () => {
    const { cookie, token } = await owner();
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token, environment: "Sandbox" };
    expect((await buy(cookie)).status).toBe(404);
    env.APPLE_IAP_SANDBOX = "1";
    try {
      expect((await buy(cookie)).status).toBe(200);
    } finally {
      env.APPLE_IAP_SANDBOX = undefined;
    }
  });

  it("leaves a plan bought on the web to the web", async () => {
    const { cookie, token } = await owner();
    await env.CONTROL.prepare("UPDATE firms SET stripe_subscription_id = 'sub_1', plan_status = 'active'").run();
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token };
    expect((await buy(cookie)).status).toBe(409);
  });

  it("maps billing retry to past due and an expired or revoked plan to ended", async () => {
    const { cookie, token } = await owner();
    appleFake.subs["2000000000001"] = { status: 3, original: "1000000000001", token };
    await buy(cookie);
    expect(await firmRow(cookie)).toMatchObject({ plan_status: "past_due" });
    expect((await firmRow(cookie)).past_due_since).not.toBeNull();
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token, revoked: true };
    await buy(cookie);
    expect(await firmRow(cookie)).toMatchObject({ plan_status: "canceled", past_due_since: null });
  });
});

describe("Apple's server notifications", () => {
  async function bought() {
    const { cookie, token } = await owner();
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token };
    await buy(cookie);
    return cookie;
  }

  const payload = async (original: string, transaction: string) =>
    ca.sign({
      notificationType: "EXPIRED",
      data: { signedTransactionInfo: await appleFake.transaction({ status: 2, original, transaction }, transaction) },
    });

  it("ask Apple again and follow the answer", async () => {
    const cookie = await bought();
    appleFake.subs["2000000000002"] = { status: 2, original: "1000000000001", token: accountToken((await firmRow(cookie)).id) };
    const res = await notify(await payload("1000000000001", "2000000000002"));
    expect(res.status).toBe(200);
    expect((await firmRow(cookie)).plan_status).toBe("canceled");
  });

  it("are taken only with Apple's signature", async () => {
    const cookie = await bought();
    appleFake.subs["2000000000002"] = { status: 2, original: "1000000000001" };
    const forged = await (await AppleCa.create()).sign({ data: { signedTransactionInfo: "x" } });
    expect((await notify(forged)).status).toBe(400);
    expect((await notify(undefined, "not json")).status).toBe(400);
    expect((await firmRow(cookie)).plan_status).toBe("active");
  });

  it("for a subscription no firm holds change nothing", async () => {
    const cookie = await bought();
    appleFake.subs["2000000000002"] = { status: 2, original: "1000000000099" };
    expect((await notify(await payload("1000000000099", "2000000000002"))).status).toBe(200);
    expect((await firmRow(cookie)).plan_status).toBe("active");
  });
});
