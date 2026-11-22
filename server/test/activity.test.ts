import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { randomId } from "../src/util";
import { api, login, openRequest, pdf, setup, upload } from "./helpers";

type Page = { rows: any[]; next: string | null };

async function owned(email = "owner@firm.test") {
  return (await env.CONTROL.prepare("SELECT id FROM firms WHERE id = (SELECT firm_id FROM users WHERE email = ?)").bind(email).first<any>())!.id as string;
}

describe("activity", () => {
  it("lists the owner's rows newest first with the staff email and links that still exist", async () => {
    const { cookie, req } = await openRequest();
    const other = await api("/api/requests", { method: "POST", cookie, body: { client_id: req.client_id, title: "Gone", deadline: Date.now() + 86_400_000 } });
    const gone = await other.json<any>();
    await api(`/api/requests/${gone.id}`, { method: "DELETE", cookie });
    const page = await (await api("/api/activity", { cookie })).json<Page>();
    expect(page.next).toBeNull();
    // rows written in the same millisecond have no fixed order
    expect(page.rows.map((r) => r.action).sort()).toEqual(["client.consent", "client.create", "firm.update", "link.create", "request.create", "request.create", "request.delete"]);
    expect(page.rows.find((r) => r.action === "request.delete")).toMatchObject({ actor_type: "user", actor: "owner@firm.test", object_id: gone.id, request_id: null });
    const kept = page.rows.find((r) => r.action === "link.create");
    expect(kept).toMatchObject({ actor_type: "user", actor: "owner@firm.test", request_id: req.id });
    expect(page.rows.find((r) => r.action === "client.create")).toMatchObject({ client_id: req.client_id, request_id: null });
    for (let i = 1; i < page.rows.length; i++) expect(page.rows[i - 1].at).toBeGreaterThanOrEqual(page.rows[i].at);
  });

  it("pages with a cursor without skipping or repeating rows that share a time", async () => {
    const { cookie } = await openRequest();
    const firmId = await owned();
    await env.DB_NA.batch(
      Array.from({ length: 120 }, (_, i) =>
        env.DB_NA.prepare("INSERT INTO audit (id, firm_id, at, actor_type, action, object_type, object_id) VALUES (?, ?, ?, 'system', 'x', 'firm', ?)")
          .bind(randomId(), firmId, 5_000_000_000_000 + Math.floor(i / 7), firmId),
      ),
    );
    const total = (await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM audit").first<any>())!.n;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page = await (await api(`/api/activity${cursor ? `?cursor=${cursor}` : ""}`, { cookie })).json<Page>();
      expect(page.rows.length).toBeLessThanOrEqual(50);
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.next;
      pages++;
    } while (cursor);
    expect(pages).toBe(Math.ceil(total / 50));
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("is for the owner only, rejects a bad cursor and shows nothing of another firm", async () => {
    const { cookie } = await openRequest();
    const firmId = await owned();
    await env.CONTROL.prepare("INSERT INTO users (id, firm_id, email, role, created_at) VALUES (?, ?, 'staff@firm.test', 'member', ?)").bind(randomId(), firmId, Date.now()).run();
    const staff = await login("staff@firm.test");
    expect((await api("/api/activity", { cookie: staff })).status).toBe(403);
    expect((await api("/api/activity?cursor=nope", { cookie })).status).toBe(400);
    expect((await api("/api/activity")).status).toBe(401);
    const b = await setup("b@two.test", "Two Inc");
    const mine = await (await api("/api/activity", { cookie: b.cookie })).json<Page>();
    expect(mine.rows.map((r) => r.action).sort()).toEqual(["client.consent", "client.create", "firm.update"]);
  });

  it("records views, downloads and exports and shows a request's own rows", async () => {
    const { cookie, req, path } = await openRequest();
    const other = await api("/api/requests", { method: "POST", cookie, body: { client_id: req.client_id, title: "Other", deadline: Date.now() + 86_400_000 } });
    const otherId = (await other.json<any>()).id;
    await api(`/api/requests/${otherId}/hold`, { method: "PUT", cookie, body: { on: true } });
    const file = await (await upload(path, req.items[0].id, pdf(300))).json<any>();
    expect((await api(`/api/files/${file.id}`, { cookie })).status).toBe(200);
    expect((await api(`/api/requests/${req.id}/export`, { cookie })).status).toBe(200);
    await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: true } });

    const { rows } = await (await api(`/api/requests/${req.id}/activity`, { cookie })).json<{ rows: any[] }>();
    expect(rows.map((r) => r.action).sort()).toEqual(["export", "file.upload", "file.view", "link.create", "request.create", "request.hold"]);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].at).toBeGreaterThanOrEqual(rows[i].at);
    expect(rows.find((r) => r.action === "file.upload")).toMatchObject({ actor_type: "client", actor: null, request_id: req.id });
    expect(rows.find((r) => r.action === "export")).toMatchObject({ actor: "owner@firm.test" });
    expect(rows.some((r) => r.object_id === otherId)).toBe(false);
  });

  it("is 404 for another firm's request and for a deleted one", async () => {
    const { cookie, req } = await openRequest();
    const b = await login("b@two.test");
    expect((await api(`/api/requests/${req.id}/activity`, { cookie: b })).status).toBe(404);
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    expect((await api(`/api/requests/${req.id}/activity`, { cookie })).status).toBe(404);
  });
});
