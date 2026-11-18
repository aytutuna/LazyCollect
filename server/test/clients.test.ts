import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, login } from "./helpers";

const add = (cookie: string, body: Record<string, unknown>) => api("/api/clients", { method: "POST", cookie, body });

describe("clients", () => {
  it("answers 401 without a session", async () => {
    expect((await api("/api/clients")).status).toBe(401);
    expect((await api("/api/clients", { method: "POST", body: {} })).status).toBe(401);
    expect((await api("/api/clients/x", { method: "DELETE" })).status).toBe(401);
  });

  it("creates and lists clients by name", async () => {
    const cookie = await login();
    expect((await add(cookie, { name: "Zed", contact_ok: false })).status).toBe(201);
    const made = await add(cookie, { name: "amy", email: " Amy@Mail.test ", phone: "613-555-0101", locale: "fr-CA", contact_ok: false });
    expect(made.status).toBe(201);
    expect(await made.json()).toMatchObject({ name: "amy", email: "amy@mail.test", phone: "613-555-0101", locale: "fr-CA" });
    const list = await (await api("/api/clients", { cookie })).json<any[]>();
    expect(list.map((c) => c.name)).toEqual(["amy", "Zed"]);
  });

  it("records the firm's contact attestation per channel", async () => {
    const cookie = await login();
    const me = await (await api("/api/me", { cookie })).json<any>();
    const both = await (await add(cookie, { name: "A", email: "a@mail.test", phone: "6135550101", contact_ok: true })).json<any>();
    expect(both.email_ok_at).toBeGreaterThan(0);
    expect(both.sms_ok_at).toBeGreaterThan(0);
    expect(both.consent_by).toBe(me.user.id);
    const emailOnly = await (await add(cookie, { name: "B", email: "b@mail.test", contact_ok: true })).json<any>();
    expect(emailOnly.email_ok_at).toBeGreaterThan(0);
    expect(emailOnly.sms_ok_at).toBeNull();
    const none = await (await add(cookie, { name: "C", email: "c@mail.test", contact_ok: false })).json<any>();
    expect([none.email_ok_at, none.sms_ok_at, none.consent_by]).toEqual([null, null, null]);
  });

  it("rejects bad input", async () => {
    const cookie = await login();
    expect((await add(cookie, { name: "A" })).status).toBe(400);
    expect((await add(cookie, { name: "A", contact_ok: "yes" })).status).toBe(400);
    expect((await add(cookie, { name: " ", contact_ok: false })).status).toBe(400);
    expect((await add(cookie, { name: "A", email: "nope", contact_ok: false })).status).toBe(400);
    expect((await add(cookie, { name: "A", phone: "abc", contact_ok: false })).status).toBe(400);
    expect((await add(cookie, { name: "A", locale: "de", contact_ok: false })).status).toBe(400);
    expect((await add(cookie, { name: "x".repeat(201), contact_ok: false })).status).toBe(400);
    const count = await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM clients").first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("updates fields and clears consent for a changed address", async () => {
    const cookie = await login();
    const made = await (await add(cookie, { name: "A", email: "a@mail.test", phone: "6135550101", contact_ok: true })).json<any>();
    const patch = (body: unknown) => api(`/api/clients/${made.id}`, { method: "PATCH", cookie, body });
    const res = await patch({ name: "B", email: "b@mail.test" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "B", email: "b@mail.test", email_ok_at: null, sms_ok_at: made.sms_ok_at });
    const again = await (await patch({ contact_ok: true })).json<any>();
    expect(again.email_ok_at).toBeGreaterThan(0);
    expect((await patch({ email: "bad" })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await api("/api/clients/nope", { method: "PATCH", cookie, body: { name: "x" } })).status).toBe(404);
  });

  it("soft deletes", async () => {
    const cookie = await login();
    const made = await (await add(cookie, { name: "A", contact_ok: false })).json<any>();
    expect((await api(`/api/clients/${made.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect(await (await api("/api/clients", { cookie })).json()).toEqual([]);
    expect((await api(`/api/clients/${made.id}`, { method: "DELETE", cookie })).status).toBe(404);
    const row = await env.DB_NA.prepare("SELECT deleted_at FROM clients WHERE id = ?").bind(made.id).first<any>();
    expect(row.deleted_at).toBeGreaterThan(0);
  });

  it("hides another firm's clients behind 404", async () => {
    const a = await login("a@one.test");
    const b = await login("b@two.test");
    const made = await (await add(a, { name: "Mine", contact_ok: false })).json<any>();
    expect(await (await api("/api/clients", { cookie: b })).json()).toEqual([]);
    expect((await api(`/api/clients/${made.id}`, { method: "PATCH", cookie: b, body: { name: "x" } })).status).toBe(404);
    expect((await api(`/api/clients/${made.id}`, { method: "DELETE", cookie: b })).status).toBe(404);
    expect(await (await api("/api/clients", { cookie: a })).json()).toHaveLength(1);
  });
});
