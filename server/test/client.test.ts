import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY } from "../src/util";
import { api, openRequest } from "./helpers";

describe("client link", () => {
  it("shows the request for a fresh link", async () => {
    const { path } = await openRequest();
    const res = await api(path);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toMatchObject({ firm_name: "Tuna Tax", title: "2025 taxes", note: "Hurry", status: "open" });
    expect(body.items.map((i: any) => [i.label, i.help, i.required, i.status, i.reject_note])).toEqual([
      ["Passport", "All pages", true, "empty", null],
      ["Visa", null, false, "empty", null],
    ]);
    expect(Object.keys(body.items[0]).sort()).toEqual(["answer", "example", "files", "help", "id", "kind", "label", "options", "reject_note", "reject_reasons", "required", "status", "unavailable_note"]);
  });

  it("logs a view at most once an hour per link", async () => {
    const { path, req } = await openRequest();
    await api(path);
    await api(path);
    const count = () => env.DB_NA.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'link.open'").first<{ n: number }>();
    expect((await count())!.n).toBe(1);
    await env.DB_NA.prepare("UPDATE audit SET at = ? WHERE action = 'link.open'").bind(Date.now() - 2 * 3_600_000).run();
    await api(path);
    expect((await count())!.n).toBe(2);
    const row = await env.DB_NA.prepare("SELECT actor_type, object_type, object_id, ip_hash FROM audit WHERE action = 'link.open'").first<any>();
    expect(row.actor_type).toBe("client");
    expect([row.object_type, row.object_id]).toEqual(["request", req.id]);
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the first time the client opened the link, once", async () => {
    const { path, req, cookie } = await openRequest();
    const opened = () => env.DB_NA.prepare("SELECT first_opened_at FROM requests WHERE id = ?").bind(req.id).first<any>().then((r) => r.first_opened_at);
    expect(await opened()).toBeNull();
    await api(path);
    const first = await opened();
    expect(first).toBeGreaterThan(0);
    await env.DB_NA.prepare("UPDATE audit SET at = 1 WHERE action = 'link.open'").run();
    await api(path);
    expect(await opened()).toBe(first);
    expect((await (await api(`/api/requests/${req.id}`, { cookie })).json<any>()).first_opened_at).toBe(first);
  });

  it("does not count the account's own staff opening the link while signed in", async () => {
    const { path, req, cookie } = await openRequest();
    await api(path, { cookie });
    const row = await env.DB_NA.prepare("SELECT first_opened_at FROM requests WHERE id = ?").bind(req.id).first<any>();
    expect(row.first_opened_at).toBeNull();
    await api(`/api/requests/${req.id}/link`, { cookie });
    expect((await env.DB_NA.prepare("SELECT first_opened_at FROM requests WHERE id = ?").bind(req.id).first<any>()).first_opened_at).toBeNull();
    await api(path);
    expect((await env.DB_NA.prepare("SELECT first_opened_at FROM requests WHERE id = ?").bind(req.id).first<any>()).first_opened_at).toBeGreaterThan(0);
  });

  it("answers the same 404 for every kind of bad token", async () => {
    const { cookie, req, path } = await openRequest();
    const token = path.split("/c/")[1];
    const bodies = new Set<string>();
    const expect404 = async (p: string) => {
      const res = await api(p);
      expect(res.status).toBe(404);
      bodies.add(await res.text());
    };
    await expect404("/api/c/garbage");
    await expect404(`/api/c/xx_${token.slice(3)}`);
    await expect404(`/api/c/na_${"A".repeat(43)}`);
    await expect404(`/api/c/${token.slice(0, -1)}`);

    await env.DB_NA.prepare("UPDATE links SET expires_at = ?").bind(Date.now() - 1).run();
    await expect404(path);
    await env.DB_NA.prepare("UPDATE links SET expires_at = ?").bind(Date.now() + DAY).run();
    expect((await api(path)).status).toBe(200);

    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    await expect404(path);
    await env.DB_NA.batch([
      env.DB_NA.prepare("UPDATE requests SET status = 'open', closed_at = NULL"),
      env.DB_NA.prepare("UPDATE links SET revoked_at = NULL"),
    ]);
    expect((await api(path)).status).toBe(200);
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1").run();
    await expect404(path);
    expect(bodies.size).toBe(1);
  });

  it("stops working for a revoked link once a new one is made", async () => {
    const { cookie, req, path } = await openRequest();
    const { url } = await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>();
    expect((await api(path)).status).toBe(404);
    expect((await api(`/api/c/${url.split("/c/")[1]}`)).status).toBe(200);
  });

  it("answers 429 once the client limiter is used up", async () => {
    const ip = "198.51.100.9";
    const statuses = [];
    for (let i = 0; i < 65; i++) statuses.push((await api("/api/c/garbage", { ip })).status);
    expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true);
    expect(statuses).toContain(429);
  });
});

describe("deleted client", () => {
  it("revokes the link, closes the request and drops it from the list", async () => {
    const { cookie, req, path } = await openRequest();
    const clientId = (await env.DB_NA.prepare("SELECT client_id FROM requests").first<any>()).client_id;
    expect((await api(path)).status).toBe(200);
    expect((await api(`/api/clients/${clientId}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await api(path)).status).toBe(404);
    expect((await (await api("/api/requests", { cookie })).json<any>()).rows).toEqual([]);
    const row = await env.DB_NA.prepare("SELECT status, closed_at FROM requests WHERE id = ?").bind(req.id).first<any>();
    expect(row.status).toBe("closed");
    expect(row.closed_at).toBeGreaterThan(0);
    const link = await env.DB_NA.prepare("SELECT revoked_at FROM links").first<any>();
    expect(link.revoked_at).toBeGreaterThan(0);
  });

  it("hides the view even if only the client row is flagged", async () => {
    const { path } = await openRequest();
    await env.DB_NA.prepare("UPDATE clients SET deleted_at = 1").run();
    expect((await api(path)).status).toBe(404);
  });
});
