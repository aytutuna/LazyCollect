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
});
