import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeClosed } from "../src/account";
import { canSend } from "../src/reminders";
import { DAY } from "../src/util";
import { addMember, api, firmRow, inDays, login, mockOutbound, openRequest, pdf, upload } from "./helpers";
import { stripeFake } from "./stripe-fake";

const close = (cookie: string, confirm = "Tuna Tax") => api("/api/account/close", { method: "POST", cookie, body: { confirm } });
const reopen = (cookie: string) => api("/api/account/reopen", { method: "POST", cookie });

const count = async (db: D1Database, table: string, firmId: string) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE firm_id = ?`).bind(firmId).first<{ n: number }>())!.n;

async function withUpload(email = "owner@firm.test") {
  const made = await openRequest(email);
  await upload(made.path, made.req.items[0].id, pdf(600));
  const firm = await firmRow(made.cookie);
  return { ...made, firm };
}

async function ageClose(days: number) {
  await env.CONTROL.prepare("UPDATE firms SET closed_at = ? WHERE closed_at IS NOT NULL").bind(Date.now() - days * DAY).run();
}

describe("close", () => {
  it("needs the owner and the typed account name", async () => {
    const { cookie } = await openRequest();
    const member = await addMember(cookie);
    expect((await close(member)).status).toBe(403);
    expect((await close(cookie, "tuna tax")).status).toBe(400);
    expect((await close(cookie, "")).status).toBe(400);
    expect((await api("/api/account/close", { method: "POST", cookie, body: {} })).status).toBe(400);
    expect((await api("/api/account/close", { method: "POST", body: { confirm: "Tuna Tax" } })).status).toBe(401);
    expect((await firmRow(cookie)).closed_at).toBeNull();
  });

  it("signs everyone out, stops client links and audits it", async () => {
    const { cookie, path, req } = await openRequest();
    const member = await addMember(cookie);
    expect((await api(path)).status).toBe(200);
    const res = await close(cookie);
    expect(res.status).toBe(200);
    expect((await api("/api/me", { cookie })).status).toBe(401);
    expect((await api("/api/me", { cookie: member })).status).toBe(401);
    expect((await api(path)).status).toBe(404);
    expect((await upload(path, req.items[0].id, pdf(300))).status).toBe(404);
    const audit = await env.DB_NA.prepare("SELECT actor_type, object_type FROM audit WHERE action = 'account.close'").all<any>();
    expect(audit.results).toEqual([{ actor_type: "user", object_type: "firm" }]);
  });

  it("stops reminders and every plan-gated action", async () => {
    const { cookie } = await openRequest();
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    await close(cookie);
    const row = await env.CONTROL.prepare(
      "SELECT id, name, legal_name, address, phone, tz, plan_status, trial_ends_at, current_period_end, closed_at, 'o@firm.test' AS owner_email FROM firms",
    ).first<any>();
    expect(canSend({ ...row, address: "1 Main St" }, Date.now())).toBe(false);
    expect(canSend({ ...row, address: "1 Main St", closed_at: null }, Date.now())).toBe(true);
  });

  it("lets the owner sign back in, but only to see the closed page", async () => {
    const { cookie } = await openRequest();
    await close(cookie);
    const again = await login();
    const me = await (await api("/api/me", { cookie: again })).json<any>();
    expect(me.firm.closed_at).toBeGreaterThan(0);
    expect(me.firm.usable).toBe(false);
    for (const path of ["/api/firm", "/api/requests", "/api/clients", "/api/templates", "/api/retention", "/api/activity", "/api/trash"]) {
      expect(await (await api(path, { cookie: again })).json()).toEqual({ error: "closed" });
    }
    expect((await api("/api/billing/checkout", { method: "POST", cookie: again })).status).toBe(403);
  });

  it("cancels the subscription first", async () => {
    const { cookie } = await openRequest();
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active', stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1', cancel_at_period_end = 1").run();
    stripeFake.sub("sub_1", "cus_1");
    await close(cookie);
    expect(stripeFake.subs.get("sub_1")!.status).toBe("canceled");
    expect(stripeFake.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/subscriptions/sub_1" });
    const row = await env.CONTROL.prepare("SELECT plan_status, cancel_at_period_end, closed_at FROM firms").first<any>();
    expect(row).toMatchObject({ plan_status: "canceled", cancel_at_period_end: 0 });
    expect(row.closed_at).toBeGreaterThan(0);
  });

  it("can be repeated after a failure, keeping the first closing time", async () => {
    const { cookie, path } = await openRequest();
    await close(cookie);
    const again = await login();
    const first = (await firmRow(again)).closed_at;
    await env.DB_NA.prepare("UPDATE links SET revoked_at = NULL").run();
    expect((await close(again)).status).toBe(200);
    expect((await env.CONTROL.prepare("SELECT closed_at FROM firms").first<any>()).closed_at).toBe(first);
    expect((await api(path)).status).toBe(404);
    expect((await env.DB_NA.prepare("SELECT DISTINCT revoked_at FROM links").first<any>()).revoked_at).toBe(first);
  });

  it("stays open when Stripe cannot cancel", async () => {
    const { cookie, path } = await openRequest();
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active', stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1'").run();
    stripeFake.sub("sub_1", "cus_1");
    stripeFake.failing = true;
    expect((await close(cookie)).status).toBe(502);
    stripeFake.failing = false;
    expect((await firmRow(cookie)).closed_at).toBeNull();
    expect((await api("/api/me", { cookie })).status).toBe(200);
    expect((await api(path)).status).toBe(200);
  });

  it("keeps a trial that never subscribed as it was", async () => {
    const { cookie } = await openRequest();
    await close(cookie);
    expect((await env.CONTROL.prepare("SELECT plan_status FROM firms").first<any>()).plan_status).toBe("trialing");
  });
});

describe("reopen", () => {
  it("brings the account and its client links back", async () => {
    const { cookie, path } = await openRequest();
    await close(cookie);
    expect((await api(path)).status).toBe(404);
    const again = await login();
    const res = await reopen(again);
    expect(res.status).toBe(200);
    expect((await firmRow(again)).closed_at).toBeNull();
    expect((await api("/api/requests", { cookie: again })).status).toBe(200);
    expect((await api(path)).status).toBe(200);
    const actions = await env.DB_NA.prepare("SELECT action FROM audit WHERE action LIKE 'account.%' ORDER BY at, rowid").all<any>();
    expect(actions.results.map((r) => r.action)).toEqual(["account.close", "account.reopen"]);
  });

  it("does not bring back a link that was revoked before", async () => {
    const { cookie, path, req } = await openRequest();
    await env.DB_NA.prepare("UPDATE links SET revoked_at = 5").run();
    await close(cookie);
    await reopen(await login());
    expect((await api(path)).status).toBe(404);
    expect(req.id).toBeTruthy();
  });

  it("needs a closed account", async () => {
    const { cookie } = await openRequest();
    expect((await reopen(cookie)).status).toBe(409);
  });

  it("is refused once the 30 days are up", async () => {
    const { cookie } = await openRequest();
    await close(cookie);
    const again = await login();
    await ageClose(31);
    expect((await reopen(again)).status).toBe(409);
    expect((await firmRow(again)).closed_at).not.toBeNull();
  });

  it("does not let a member reopen", async () => {
    const { cookie } = await openRequest();
    await close(cookie);
    const again = await login();
    const member = await addMember(again);
    expect((await reopen(member)).status).toBe(403);
  });
});

describe("purge of a closed account", () => {
  it("gives a firm that cannot finish no more turns than the others", async () => {
    const held = await withUpload("held@firm.test");
    await api(`/api/requests/${held.req.id}/hold`, { method: "PUT", cookie: held.cookie, body: { on: true } });
    await close(held.cookie);
    await new Promise((r) => setTimeout(r, 5));
    const other = await withUpload("other@firm.test");
    await close(other.cookie);
    await ageClose(31);
    await env.CONTROL.prepare("UPDATE firms SET purge_tried_at = 1 WHERE id = ?").bind(held.firm.id).run();
    await purgeClosed(env);
    const tried = await env.CONTROL.prepare("SELECT purge_tried_at FROM firms WHERE id = ?").bind(held.firm.id).first<any>();
    expect(tried.purge_tried_at).toBeGreaterThan(1);
    expect(await env.CONTROL.prepare("SELECT 1 FROM firms WHERE id = ?").bind(other.firm.id).first()).toBeNull();
  });

  it("does nothing inside the 30 days", async () => {
    await withUpload();
    const { cookie } = await openRequest("other@firm.test");
    await close(cookie);
    await ageClose(29);
    await purgeClosed(env);
    expect((await env.CONTROL.prepare("SELECT COUNT(*) AS n FROM firms").first<any>()).n).toBe(2);
    expect((await env.FILES_NA.list()).objects.length).toBeGreaterThan(0);
  });

  it("removes everything of the account, the key included", async () => {
    const { cookie, firm } = await withUpload();
    const member = await addMember(cookie);
    await api("/api/templates", { method: "POST", cookie, body: { name: "Mine", items: [{ label: "A", required: true }] } });
    await api("/api/retention", { method: "PUT", cookie, body: { years: 3 } });
    await close(cookie);
    await login();
    expect(firm.dek_wrapped).toBeTruthy();
    expect((await env.FILES_NA.list({ prefix: `f/${firm.id}/` })).objects.length).toBe(1);
    await ageClose(31);
    await purgeClosed(env);

    expect((await env.FILES_NA.list({ prefix: `f/${firm.id}/` })).objects).toHaveLength(0);
    for (const table of ["requests", "items", "files", "links", "clients", "templates", "firm_settings", "audit", "messages"]) {
      expect(await count(env.DB_NA, table, firm.id), table).toBe(0);
    }
    expect(await env.CONTROL.prepare("SELECT * FROM firms WHERE id = ?").bind(firm.id).first()).toBeNull();
    for (const table of ["users", "sessions"]) expect(await count(env.CONTROL, table, firm.id), table).toBe(0);
    expect((await env.CONTROL.prepare("SELECT COUNT(*) AS n FROM login_codes").first<any>()).n).toBe(0);
    expect(member).toBeTruthy();

    const log = await env.DB_NA.prepare("SELECT kind, reason, files, target_id FROM deletion_log WHERE firm_id = ? ORDER BY kind").bind(firm.id).all<any>();
    expect(log.results).toEqual([
      { kind: "firm", reason: "closed", files: 1, target_id: firm.id },
      { kind: "request", reason: "closed", files: 1, target_id: expect.any(String) },
    ]);
    // what outlives a request: the record that its messages were sent
    await purgeClosed(env);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM deletion_log WHERE kind = 'firm'").first<any>())!.n).toBe(1);
  });

  it("keeps requests on legal hold and everything they need", async () => {
    const { cookie, req, firm } = await withUpload();
    const [client] = await (await api("/api/clients", { cookie })).json<any[]>();
    const second = await (
      await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "Second", deadline: inDays(7), items: [{ label: "ID", required: true }] } })
    ).json<any>();
    const link = await (await api(`/api/requests/${second.id}/link`, { method: "POST", cookie })).json<any>();
    await upload(`/api/c/${link.url.split("/c/")[1]}`, second.items[0].id, pdf(400));
    expect((await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: true } })).status).toBe(200);

    await close(cookie);
    await ageClose(31);
    await purgeClosed(env);
    await purgeClosed(env);

    const left = await env.DB_NA.prepare("SELECT id FROM requests WHERE firm_id = ?").bind(firm.id).all<any>();
    expect(left.results).toEqual([{ id: req.id }]);
    expect(await count(env.DB_NA, "files", firm.id)).toBe(1);
    expect((await env.FILES_NA.list({ prefix: `f/${firm.id}/` })).objects).toHaveLength(1);
    expect(await count(env.DB_NA, "clients", firm.id)).toBe(1);
    const row = await env.CONTROL.prepare("SELECT dek_wrapped FROM firms WHERE id = ?").bind(firm.id).first<any>();
    expect(row.dek_wrapped).toBeTruthy();
    expect(await count(env.CONTROL, "users", firm.id)).toBe(1);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM deletion_log WHERE kind = 'firm'").first<any>())!.n).toBe(0);
  });

  it("leaves other accounts alone", async () => {
    const a = await withUpload("a@firm.test");
    const b = await withUpload("b@firm.test");
    await close(a.cookie);
    await ageClose(31);
    await purgeClosed(env);
    expect(await count(env.DB_NA, "files", b.firm.id)).toBe(1);
    expect(await count(env.DB_NA, "requests", b.firm.id)).toBe(1);
    expect((await env.FILES_NA.list({ prefix: `f/${b.firm.id}/` })).objects).toHaveLength(1);
    expect((await api(b.path)).status).toBe(200);
    expect((await api("/api/requests", { cookie: b.cookie })).status).toBe(200);
    expect((await env.CONTROL.prepare("SELECT dek_wrapped FROM firms WHERE id = ?").bind(b.firm.id).first<any>())!.dek_wrapped).toBeTruthy();
  });
});
