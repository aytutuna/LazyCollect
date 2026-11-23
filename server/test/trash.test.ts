import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY, RESTORE_WINDOW } from "../src/util";
import { api, login, openRequest } from "./helpers";

describe("recently deleted", () => {
  it("lists deleted requests and clients with their purge date", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    const first = await (await api("/api/trash", { cookie })).json<any>();
    expect(first.clients).toEqual([]);
    expect(first.requests).toHaveLength(1);
    expect(first.requests[0]).toMatchObject({ id: req.id, title: "2025 taxes", client_name: "Amy" });
    expect(first.requests[0].purge_at).toBe(first.requests[0].deleted_at + RESTORE_WINDOW);
    expect(await (await api("/api/requests", { cookie })).json()).toEqual([]);

    await api(`/api/clients/${req.client_id}`, { method: "DELETE", cookie });
    const both = await (await api("/api/trash", { cookie })).json<any>();
    expect(both.clients.map((c: any) => c.name)).toEqual(["Amy"]);
  });

  it("hides what is older than the window and what belongs to another firm", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    const other = await login("other@firm.test");
    expect(await (await api("/api/trash", { cookie: other })).json()).toEqual({ requests: [], clients: [] });
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = ?").bind(Date.now() - RESTORE_WINDOW - DAY).run();
    expect((await (await api("/api/trash", { cookie })).json<any>()).requests).toEqual([]);
  });
});

describe("restore", () => {
  it("brings a request back closed, without a live link", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    const res = await api(`/api/requests/${req.id}/restore`, { method: "POST", cookie });
    expect(res.status).toBe(200);
    const row = (await env.DB_NA.prepare("SELECT status, deleted_at, closed_at, ended_at, keep_until FROM requests").first<any>())!;
    expect(row).toMatchObject({ status: "closed", deleted_at: null });
    expect(row.closed_at).toBeGreaterThan(0);
    expect(row.keep_until).toBeGreaterThan(row.ended_at);
    expect((await env.DB_NA.prepare("SELECT revoked_at FROM links").first<any>())!.revoked_at).toBeGreaterThan(0);
    expect((await (await api("/api/requests", { cookie })).json<any[]>()).map((r) => r.id)).toEqual([req.id]);
    expect((await api(`/api/requests/${req.id}/restore`, { method: "POST", cookie })).status).toBe(404);
    expect((await env.DB_NA.prepare("SELECT action FROM audit WHERE action = 'request.restore'").all()).results).toHaveLength(1);
  });

  it("starts a new clock when the old one had already run out", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    await env.DB_NA.prepare("UPDATE requests SET ended_at = ?, keep_until = ?").bind(Date.now() - 8 * 365 * DAY, Date.now() - 365 * DAY).run();
    await api(`/api/requests/${req.id}/restore`, { method: "POST", cookie });
    const row = (await env.DB_NA.prepare("SELECT ended_at, keep_until FROM requests").first<any>())!;
    expect(row.ended_at).toBeGreaterThan(Date.now() - 60_000);
    expect(row.keep_until).toBeGreaterThan(Date.now() + 6 * 365 * DAY);
  });

  it("refuses after 30 days, for a live request and for another firm", async () => {
    const { cookie, req } = await openRequest();
    expect((await api(`/api/requests/${req.id}/restore`, { method: "POST", cookie })).status).toBe(404);
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    const other = await login("other@firm.test");
    expect((await api(`/api/requests/${req.id}/restore`, { method: "POST", cookie: other })).status).toBe(404);
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = ?").bind(Date.now() - RESTORE_WINDOW).run();
    expect((await api(`/api/requests/${req.id}/restore`, { method: "POST", cookie })).status).toBe(404);
    expect((await env.DB_NA.prepare("SELECT deleted_at FROM requests").first<any>())!.deleted_at).not.toBeNull();
  });

  it("restores a client without reopening its requests or links", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/clients/${req.client_id}`, { method: "DELETE", cookie });
    const other = await login("other@firm.test");
    expect((await api(`/api/clients/${req.client_id}/restore`, { method: "POST", cookie: other })).status).toBe(404);
    expect((await api(`/api/clients/${req.client_id}/restore`, { method: "POST", cookie })).status).toBe(200);
    expect((await env.DB_NA.prepare("SELECT deleted_at FROM clients").first<any>())!.deleted_at).toBeNull();
    expect((await env.DB_NA.prepare("SELECT status FROM requests").first<any>())!.status).toBe("closed");
    expect((await env.DB_NA.prepare("SELECT revoked_at FROM links").first<any>())!.revoked_at).toBeGreaterThan(0);
    expect((await api(`/api/clients/${req.client_id}/restore`, { method: "POST", cookie })).status).toBe(404);
  });

  it("needs the client back before a request of theirs can return", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    await api(`/api/clients/${req.client_id}`, { method: "DELETE", cookie });
    const res = await api(`/api/requests/${req.id}/restore`, { method: "POST", cookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "client_deleted" });
    await api(`/api/clients/${req.client_id}/restore`, { method: "POST", cookie });
    expect((await api(`/api/requests/${req.id}/restore`, { method: "POST", cookie })).status).toBe(200);
  });

  it("does not restore a client after 30 days", async () => {
    const { cookie, req } = await openRequest();
    await api(`/api/clients/${req.client_id}`, { method: "DELETE", cookie });
    await env.DB_NA.prepare("UPDATE clients SET deleted_at = ?").bind(Date.now() - RESTORE_WINDOW).run();
    expect((await api(`/api/clients/${req.client_id}/restore`, { method: "POST", cookie })).status).toBe(404);
  });
});
