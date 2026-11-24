import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { accountToken } from "../src/apple";
import { AppleCa, appleFake } from "./apple-fake";
import { refreshApple } from "../src/apple";
import { usable } from "../src/firm";
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

describe("Apple against the web plan", () => {
  it("refuses a purchase while a web trial subscription is held", async () => {
    const { cookie, token } = await owner();
    await env.CONTROL.prepare("UPDATE firms SET stripe_subscription_id = 'sub_1', plan_status = 'trialing'").run();
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token };
    expect((await buy(cookie)).status).toBe(409);
  });

  it("ignores a late notification once the web plan took over, or one that names another firm", async () => {
    const { cookie, token } = await owner();
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token };
    await buy(cookie);
    const sign = (id: string) => ca.sign({ data: { signedTransactionInfo: undefined } }).then(async () => ca.sign({ data: { signedTransactionInfo: await appleFake.transaction({ status: 2, original: "1000000000001", transaction: id }, id) } }));
    appleFake.subs["2000000000002"] = { status: 2, original: "1000000000001", token: accountToken("f".repeat(32)) };
    await notify(await sign("2000000000002"));
    expect((await firmRow(cookie)).plan_status).toBe("active");
    appleFake.subs["2000000000002"] = { status: 2, original: "1000000000001", token };
    await env.CONTROL.prepare("UPDATE firms SET plan_source = 'stripe', plan_status = 'active'").run();
    await notify(await sign("2000000000002"));
    expect((await firmRow(cookie)).plan_status).toBe("active");
  });
});

describe("Apple plans over time and in the rest of the app", () => {
  async function bought(email = "owner@firm.test", original = "1000000000001", expires = Date.now() + 30 * 86_400_000) {
    const o = await owner(email);
    appleFake.subs["2000000000001"] = { status: 1, original, token: o.token, expires };
    expect((await buy(o.cookie)).status).toBe(200);
    return o;
  }

  it("does not take certificates that had expired", async () => {
    const { cookie, token } = await owner();
    appleFake.ca = ca = await AppleCa.create({ expired: true });
    env.APPLE_IAP_ROOT = ca.rootPem;
    appleFake.subs["2000000000001"] = { status: 1, original: "1000000000001", token };
    expect((await buy(cookie)).status).toBe(404);
  });

  it("lets an active plan lapse once its period and the grace are past, and not before", async () => {
    const { cookie } = await bought();
    const row = await firmRow(cookie);
    const end = row.current_period_end;
    expect(usable(row, end + 6 * 86_400_000)).toBe(true);
    expect(usable(row, end + 8 * 86_400_000)).toBe(false);
    // a web plan has no such limit
    expect(usable({ ...row, plan_source: "stripe" }, end + 30 * 86_400_000)).toBe(true);
  });

  it("asks Apple again about a plan that is about to end, and follows the answer", async () => {
    const { cookie, token } = await bought("owner@firm.test", "1000000000001", Date.now() + 3_600_000);
    appleFake.subs["1000000000001"] = { status: 2, original: "1000000000001", token };
    await refreshApple(env, Date.now());
    expect((await firmRow(cookie)).plan_status).toBe("canceled");
    // a plan with time left is left alone
    const other = await bought("two@firm.test", "1000000000002");
    const calls = appleFake.calls.length;
    await refreshApple(env, Date.now());
    expect(appleFake.calls.length).toBe(calls);
    expect((await firmRow(other.cookie)).plan_status).toBe("active");
  });

  it("counts an Apple payer as subscribed in /me and as a used account", async () => {
    const { cookie } = await bought();
    expect((await (await api("/api/me", { cookie })).json<any>()).firm.subscribed).toBe(true);
    const { untouchedSql } = await import("../src/firm");
    const firm = await firmRow(cookie);
    const u = untouchedSql(firm.id, Date.now());
    const hit = await env.CONTROL.prepare(`SELECT 1 AS x FROM firms WHERE id = ? AND ${u.sql}`).bind(firm.id, ...u.binds).first();
    expect(hit).toBeNull();
  });

  it("tells the owner who closes the account to cancel in the App Store, and records it", async () => {
    const { cookie } = await bought();
    const res = await api("/api/account/close", { method: "POST", cookie, body: { confirm: "Tuna Tax" } });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.store_subscription).toMatchObject({ source: "apple", manage_url: "https://apps.apple.com/account/subscriptions" });
    const log = await env.CONTROL.prepare("SELECT 1 FROM firms WHERE closed_at IS NOT NULL").first();
    expect(log).not.toBeNull();
    const audited = await env.DB_NA.prepare("SELECT meta FROM audit WHERE action = 'account.close'").first<{ meta: string }>();
    expect(audited?.meta).toContain("apple");
  });

  it("does not let a second, expired transaction replace a live plan", async () => {
    const { cookie, token } = await bought();
    appleFake.subs["2000000000002"] = { status: 2, original: "1000000000002", token };
    expect((await buy(cookie, "2000000000002")).status).toBe(409);
    expect(await firmRow(cookie)).toMatchObject({ plan_status: "active", apple_original_transaction_id: "1000000000001" });
  });
});
