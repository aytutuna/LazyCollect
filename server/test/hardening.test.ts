import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { mintLink } from "../src/links";
import { api, firmRow, inDays, login, openRequest, setup } from "./helpers";

const fill = (table: string, firmId: string, count: number, columns: string, values: string) =>
  env.DB_NA.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
     INSERT INTO ${table} (id, firm_id, ${columns}) SELECT lower(hex(randomblob(16))), ?, ${values} FROM n`,
  )
    .bind(firmId)
    .run();

describe("firm write limit", () => {
  it("answers 429 after 120 writes a minute, for that firm only", async () => {
    const a = await login("a@firm.test");
    const b = await login("b@firm.test");
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) statuses.push((await api("/api/templates/none", { method: "DELETE", cookie: a })).status);
    expect(statuses.slice(0, 120).every((s) => s === 404)).toBe(true);
    expect(statuses[120]).toBe(429);
    expect((await api("/api/templates/none", { method: "DELETE", cookie: b })).status).toBe(404);
    expect((await api("/api/templates", { cookie: a })).status).toBe(200);
  }, 30_000);
});

describe("export limit", () => {
  it("allows 10 exports a minute per firm", async () => {
    const { cookie, req } = await openRequest();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await api(`/api/requests/${req.id}/export`, { cookie })).status);
    expect(statuses.slice(0, 10).every((s) => s === 409)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("count caps", () => {
  it("stops a firm at 200 templates", async () => {
    const cookie = await login();
    const { id } = await firmRow(cookie);
    await fill("templates", id, 199, "name, items_json, created_at, updated_at", "'T' || i, '[]', 0, 0");
    const body = { name: "One more", items: [{ label: "Passport", required: true }] };
    expect((await api("/api/templates", { method: "POST", cookie, body })).status).toBe(201);
    const res = await api("/api/templates", { method: "POST", cookie, body });
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error).toBe("too_many_templates");
    const audits = await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'template.create'").first<any>();
    expect(audits.n).toBe(1);
  });

  it("stops a firm at 10000 clients", async () => {
    const cookie = await login();
    const { id } = await firmRow(cookie);
    await fill("clients", id, 9999, "name, created_by, created_at", "'C' || i, 'x', 0");
    const body = { name: "Last", email: "last@mail.test", contact_ok: true };
    expect((await api("/api/clients", { method: "POST", cookie, body })).status).toBe(201);
    const res = await api("/api/clients", { method: "POST", cookie, body });
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error).toBe("too_many_clients");
    const audits = await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'client.create'").first<any>();
    expect(audits.n).toBe(1);
  });

  it("stops a firm at 300 new requests a day, and the count slides", async () => {
    const { cookie, client } = await setup();
    const { id } = await firmRow(cookie);
    await fill("requests", id, 299, "client_id, title, deadline, created_by, created_at", `'${client.id}', 'R' || i, ${inDays(5)}, 'x', ${Date.now() - 1000}`);
    const body = { client_id: client.id, title: "Next", deadline: inDays(5), items: [{ label: "Passport", required: true }] };
    expect((await api("/api/requests", { method: "POST", cookie, body })).status).toBe(201);
    const res = await api("/api/requests", { method: "POST", cookie, body });
    expect(res.status).toBe(429);
    expect((await res.json<any>()).error).toBe("too_many_requests");
    const orphans = await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM items WHERE request_id NOT IN (SELECT id FROM requests)").first<any>();
    expect(orphans.n).toBe(0);
    await env.DB_NA.prepare("UPDATE requests SET created_at = created_at - 90000000").run();
    expect((await api("/api/requests", { method: "POST", cookie, body })).status).toBe(201);
  });
});

describe("link minted while closing", () => {
  const close = (cookie: string) => api("/api/account/close", { method: "POST", cookie, body: { confirm: "Tuna Tax" } });

  it("is refused once the close batch has run, even before the account row says closed", async () => {
    const { cookie, req, path } = await openRequest();
    const firm = await firmRow(cookie);
    await close(cookie);
    // the control database is what the gap is about, so put it back as it was a moment before
    await env.CONTROL.prepare("UPDATE firms SET closed_at = NULL").run();
    expect((await env.DB_NA.prepare("SELECT closed_at FROM firm_settings WHERE firm_id = ?").bind(firm.id).first<any>()).closed_at).toBeGreaterThan(0);
    await expect(mintLink(env, env.DB_NA, "na", firm.id, req.id, Date.now() + 86_400_000, Date.now())).rejects.toThrow("link refused");
    const live = await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM links WHERE revoked_at IS NULL").first<any>();
    expect(live.n).toBe(0);
    // a link that slipped through is still dead for the client
    await env.DB_NA.prepare("UPDATE links SET revoked_at = NULL").run();
    expect((await api(path)).status).toBe(404);
  });

  it("is cleared by a reopen, which brings the links back", async () => {
    const { cookie, path, req } = await openRequest();
    const firm = await firmRow(cookie);
    await close(cookie);
    expect((await api(path)).status).toBe(404);
    const again = await login();
    expect((await api("/api/account/reopen", { method: "POST", cookie: again })).status).toBe(200);
    expect((await env.DB_NA.prepare("SELECT closed_at FROM firm_settings WHERE firm_id = ?").bind(firm.id).first<any>()).closed_at).toBeNull();
    expect((await api(path)).status).toBe(200);
    await expect(mintLink(env, env.DB_NA, "na", firm.id, req.id, Date.now() + 86_400_000, Date.now())).resolves.toMatch(/^na_/);
  });
});
