import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { usable } from "../src/firm";
import { DAY, randomId, sha256 } from "../src/util";
import { api, login } from "./helpers";

describe("firm", () => {
  it("answers 401 without a session", async () => {
    expect((await api("/api/firm")).status).toBe(401);
    expect((await api("/api/firm", { method: "PATCH", body: { name: "x" } })).status).toBe(401);
  });

  it("returns the profile and plan of a new firm", async () => {
    const cookie = await login();
    const res = await api("/api/firm", { cookie });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toMatchObject({ name: null, legal_name: null, province: null, plan_status: "trialing" });
    expect(body.region).toBeUndefined();
  });

  it("lets the owner update the profile", async () => {
    const cookie = await login();
    const patch = await api("/api/firm", {
      method: "PATCH",
      cookie,
      body: { name: "Tuna Tax", legal_name: "Tuna Tax Inc.", address: "1 Main St, Kingston ON", phone: "613 555 0100", province: "ON" },
    });
    expect(patch.status).toBe(200);
    const body = await (await api("/api/firm", { cookie })).json<any>();
    expect(body).toMatchObject({ name: "Tuna Tax", legal_name: "Tuna Tax Inc.", province: "ON", phone: "613 555 0100" });
  });

  it("rejects bad profile input", async () => {
    const cookie = await login();
    const patch = (body: unknown) => api("/api/firm", { method: "PATCH", cookie, body });
    expect((await patch({ name: "" })).status).toBe(400);
    expect((await patch({ name: 5 })).status).toBe(400);
    expect((await patch({ province: "XX" })).status).toBe(400);
    expect((await patch({ phone: "x".repeat(41) })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch([1])).status).toBe(400);
  });

  it("forbids a member from changing the profile", async () => {
    const owner = await login();
    const me = await (await api("/api/me", { cookie: owner })).json<any>();
    const token = "member-session-token";
    const now = Date.now();
    const userId = randomId();
    await env.CONTROL.batch([
      env.CONTROL.prepare("INSERT INTO users (id, firm_id, email, role, created_at) VALUES (?, ?, 'm@firm.test', 'member', ?)").bind(userId, me.firm.id, now),
      env.CONTROL.prepare("INSERT INTO sessions (token_hash, user_id, firm_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
        await sha256(token),
        userId,
        me.firm.id,
        now,
        now,
        now + 100_000,
      ),
    ]);
    const cookie = `__Host-lc_session=${token}`;
    expect((await api("/api/firm", { cookie })).status).toBe(200);
    expect((await api("/api/firm", { method: "PATCH", cookie, body: { name: "Mine" } })).status).toBe(403);
  });
});

describe("usable", () => {
  const now = 1_000_000_000_000;
  const f = (over: Partial<Parameters<typeof usable>[0]>) => ({ plan_status: "trialing", trial_ends_at: null, current_period_end: null, closed_at: null, ...over });

  it("follows the plan status", () => {
    expect(usable(f({ plan_status: "active" }), now)).toBe(true);
    expect(usable(f({ plan_status: "canceled" }), now)).toBe(false);
  });

  it("allows a trial until it ends", () => {
    expect(usable(f({ trial_ends_at: now + 1 }), now)).toBe(true);
    expect(usable(f({ trial_ends_at: now }), now)).toBe(false);
    expect(usable(f({ trial_ends_at: null }), now)).toBe(false);
  });

  it("gives a past due account a week after the period end", () => {
    const due = f({ plan_status: "past_due", current_period_end: now - 6 * DAY });
    expect(usable(due, now)).toBe(true);
    expect(usable(due, now + DAY - 1)).toBe(true);
    expect(usable(due, now + DAY)).toBe(false);
    expect(usable(f({ plan_status: "past_due" }), now)).toBe(false);
  });

  it("never allows a closed account", () => {
    expect(usable(f({ plan_status: "active", closed_at: now - 1 }), now)).toBe(false);
  });
});
