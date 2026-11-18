import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, inDays, setup } from "./helpers";

describe("tenant isolation", () => {
  it("gives a second firm 404 on every id of the first", async () => {
    const a = await setup("a@one.test", "One Inc");
    const b = await setup("b@two.test", "Two Inc");
    const template = await (await api("/api/templates", { method: "POST", cookie: a.cookie, body: { name: "Mine", items: [{ label: "x" }] } })).json<any>();
    const req = await (
      await api("/api/requests", { method: "POST", cookie: a.cookie, body: { client_id: a.client.id, title: "A", deadline: inDays(7), items: [{ label: "x" }] } })
    ).json<any>();
    const itemId = req.items[0].id;
    const cookie = b.cookie;
    const send = (path: string, method: string, body?: unknown) => api(path, { method, cookie, body });

    const calls: [string, string, unknown?][] = [
      ["PATCH", `/api/clients/${a.client.id}`, { name: "x" }],
      ["DELETE", `/api/clients/${a.client.id}`],
      ["PATCH", `/api/templates/${template.id}`, { name: "x" }],
      ["DELETE", `/api/templates/${template.id}`],
      ["GET", `/api/requests/${req.id}`],
      ["PATCH", `/api/requests/${req.id}`, { title: "x" }],
      ["POST", `/api/requests/${req.id}/items`, { label: "x" }],
      ["PATCH", `/api/requests/${req.id}/items/${itemId}`, { label: "x" }],
      ["DELETE", `/api/requests/${req.id}/items/${itemId}`],
      ["DELETE", `/api/requests/${req.id}`],
      ["POST", `/api/requests/${req.id}/close`],
      ["POST", `/api/requests/${req.id}/link`],
      ["POST", "/api/requests", { client_id: a.client.id, title: "A", deadline: inDays(7) }],
      ["POST", "/api/requests", { client_id: b.client.id, title: "A", deadline: inDays(7), template_id: template.id }],
    ];
    for (const [method, path, body] of calls) {
      expect([method, path, (await send(path, method, body)).status]).toEqual([method, path, 404]);
    }

    expect(await (await api("/api/requests", { cookie })).json()).toEqual([]);
    const clients = await (await api("/api/clients", { cookie })).json<any[]>();
    expect(clients.map((c) => c.id)).toEqual([b.client.id]);
    const own = await (await api("/api/templates", { cookie })).json<any[]>();
    expect(own.some((t) => t.id === template.id)).toBe(false);

    const after = await (await api(`/api/requests/${req.id}`, { cookie: a.cookie })).json<any>();
    expect(after).toMatchObject({ title: "A", status: "draft" });
    expect(after.items).toHaveLength(1);
  });

  it("keeps the first firm's rows unchanged after the second firm's attempts", async () => {
    const a = await setup("a@one.test", "One Inc");
    const b = await setup("b@two.test", "Two Inc");
    const template = await (await api("/api/templates", { method: "POST", cookie: a.cookie, body: { name: "Mine", items: [{ label: "x" }] } })).json<any>();
    const req = await (
      await api("/api/requests", { method: "POST", cookie: a.cookie, body: { client_id: a.client.id, title: "A", deadline: inDays(7), items: [{ label: "x" }] } })
    ).json<any>();
    const mine = await (await api("/api/requests", { method: "POST", cookie: b.cookie, body: { client_id: b.client.id, title: "B", deadline: inDays(7), items: [{ label: "y" }] } })).json<any>();
    const firmA = (await env.DB_NA.prepare("SELECT firm_id FROM clients WHERE id = ?").bind(a.client.id).first<any>()).firm_id;
    const rows = async () =>
      JSON.stringify(await Promise.all(["clients", "templates", "requests", "items"].map((t) => env.DB_NA.prepare(`SELECT * FROM ${t} WHERE firm_id = ? ORDER BY id`).bind(firmA).all().then((r) => r.results))));
    const before = await rows();

    const itemId = req.items[0].id;
    const cookie = b.cookie;
    expect((await api(`/api/requests/${mine.id}/items/${itemId}`, { method: "PATCH", cookie, body: { label: "hacked" } })).status).toBe(404);
    expect((await api(`/api/requests/${mine.id}/items/${itemId}`, { method: "DELETE", cookie })).status).toBe(404);
    await api(`/api/clients/${a.client.id}`, { method: "PATCH", cookie, body: { name: "hacked" } });
    await api(`/api/clients/${a.client.id}`, { method: "DELETE", cookie });
    await api(`/api/templates/${template.id}`, { method: "PATCH", cookie, body: { name: "hacked" } });
    await api(`/api/templates/${template.id}`, { method: "DELETE", cookie });
    expect(await rows()).toBe(before);
  });

  it("does not let an item be addressed under another request of the same firm", async () => {
    const { cookie, client } = await setup();
    const mk = async (title: string) =>
      (await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title, deadline: inDays(7), items: [{ label: title }] } })).json<any>());
    const x = await mk("X");
    const y = await mk("Y");
    const path = `/api/requests/${y.id}/items/${x.items[0].id}`;
    expect((await api(path, { method: "PATCH", cookie, body: { label: "moved" } })).status).toBe(404);
    expect((await api(path, { method: "DELETE", cookie })).status).toBe(404);
    const row = await env.DB_NA.prepare("SELECT label, request_id FROM items WHERE id = ?").bind(x.items[0].id).first<any>();
    expect(row).toEqual({ label: "X", request_id: x.id });
  });
});
