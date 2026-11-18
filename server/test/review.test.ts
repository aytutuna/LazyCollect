import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, inDays, openRequest, pdf, setup, upload } from "./helpers";

const review = (cookie: string, reqId: string, itemId: string, body: unknown) =>
  api(`/api/requests/${reqId}/items/${itemId}/review`, { method: "POST", cookie, body });

async function submitted() {
  const o = await openRequest();
  const item = o.req.items[0].id;
  const file = await (await upload(o.path, item, pdf(2000), { name: "a.pdf" })).json<any>();
  return { ...o, item, file };
}

describe("review", () => {
  it("approves a submitted item and clears the note", async () => {
    const { cookie, req, item } = await submitted();
    await review(cookie, req.id, item, { decision: "reject", note: "Blurry" });
    await env.DB_NA.prepare("UPDATE items SET status = 'submitted'").run();
    const res = await review(cookie, req.id, item, { decision: "approve", note: "ignored" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: item, status: "approved", reject_note: null });
    expect((await env.DB_NA.prepare("SELECT reviewed_by, reviewed_at FROM items WHERE id = ?").bind(item).first<any>())!.reviewed_at).toBeGreaterThan(0);
  });

  it("rejects with a note and needs one", async () => {
    const { cookie, req, item } = await submitted();
    for (const body of [{ decision: "reject" }, { decision: "reject", note: "  " }, { decision: "reject", note: "x".repeat(501) }, { decision: "reject", note: 5 }]) {
      expect([JSON.stringify(body), (await review(cookie, req.id, item, body)).status]).toEqual([JSON.stringify(body), 400]);
    }
    const ok = await review(cookie, req.id, item, { decision: "reject", note: "x".repeat(500) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "rejected", reject_note: "x".repeat(500) });
  });

  it("rejects unknown decisions and bodies", async () => {
    const { cookie, req, item } = await submitted();
    for (const body of [{}, { decision: "maybe" }, { note: "x" }]) expect((await review(cookie, req.id, item, body)).status).toBe(400);
    const raw = await api(`/api/requests/${req.id}/items/${item}/review`, { method: "POST", cookie, headers: { "content-type": "text/plain" } });
    expect(raw.status).toBe(400);
  });

  it("only touches submitted or approved items", async () => {
    const { cookie, req, item } = await submitted();
    const empty = req.items[1].id;
    const res = await review(cookie, req.id, empty, { decision: "approve" });
    expect(res.status).toBe(409);
    expect((await env.DB_NA.prepare("SELECT status FROM items WHERE id = ?").bind(empty).first<any>())!.status).toBe("empty");
    await review(cookie, req.id, item, { decision: "reject", note: "Blurry" });
    expect((await review(cookie, req.id, item, { decision: "approve" })).status).toBe(409);
    expect((await review(cookie, req.id, item, { decision: "reject", note: "Again" })).status).toBe(409);
    expect((await review(cookie, req.id, "0".repeat(32), { decision: "approve" })).status).toBe(404);
    expect((await review(cookie, "0".repeat(32), item, { decision: "approve" })).status).toBe(404);
  });

  it("lets an approved item be rejected later", async () => {
    const { cookie, req, item } = await submitted();
    await review(cookie, req.id, item, { decision: "approve" });
    expect((await review(cookie, req.id, item, { decision: "reject", note: "Wrong year" })).status).toBe(200);
  });

  it("refuses on closed requests", async () => {
    const { cookie, req, item } = await submitted();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    expect((await review(cookie, req.id, item, { decision: "approve" })).status).toBe(409);
  });

  it("writes an audit row and keeps the request complete after an approval", async () => {
    const { cookie, req, item } = await submitted();
    await review(cookie, req.id, item, { decision: "approve" });
    const row = (await env.DB_NA.prepare("SELECT * FROM audit WHERE action = 'item.review'").first<any>())!;
    expect(row).toMatchObject({ actor_type: "user", object_type: "item", object_id: item });
    expect(JSON.parse(row.meta)).toEqual({ request: req.id, decision: "approve" });
    expect((await env.DB_NA.prepare("SELECT status FROM requests").first<any>())!.status).toBe("complete");
    expect((await review(cookie, req.id, req.items[1].id, { decision: "approve" })).status).toBe(409);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'item.review'").first<any>())!.n).toBe(1);
  });

  it("lists files per item on the request", async () => {
    const { cookie, req, item, file } = await submitted();
    const got = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    expect(got.items[0].files).toEqual([{ id: file.id, name: "a.pdf", size: 2000, mime: "application/pdf", uploaded_at: file.uploaded_at }]);
    expect(got.items[1].files).toEqual([]);
    expect(got.items[0].id).toBe(item);
  });
});

describe("file download", () => {
  it("sends an attachment with safe headers and audits the view", async () => {
    const { cookie, file } = await submitted();
    const res = await api(`/api/files/${file.id}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="a.pdf"; filename*=UTF-8''a.pdf`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-length")).toBe("2000");
    await res.arrayBuffer();
    const row = (await env.DB_NA.prepare("SELECT * FROM audit WHERE action = 'file.view'").first<any>())!;
    expect(row).toMatchObject({ actor_type: "user", object_type: "file", object_id: file.id });
  });

  it("needs a session", async () => {
    const { file } = await submitted();
    expect((await api(`/api/files/${file.id}`)).status).toBe(401);
  });

  it("hides removed files and files of deleted requests", async () => {
    const { cookie, file, req } = await submitted();
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    expect((await api(`/api/files/${file.id}`, { cookie })).status).toBe(404);
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = NULL").run();
    expect((await api(`/api/files/${file.id}`, { cookie })).status).toBe(200);
    await env.DB_NA.prepare("UPDATE files SET deleted_at = 1").run();
    expect((await api(`/api/files/${file.id}`, { cookie })).status).toBe(404);
  });

  it("is invisible to another firm", async () => {
    const { req, item, file } = await submitted();
    const other = await setup("b@two.test", "Two Inc");
    expect((await api(`/api/files/${file.id}`, { cookie: other.cookie })).status).toBe(404);
    expect((await review(other.cookie, req.id, item, { decision: "approve" })).status).toBe(404);
    expect((await review(other.cookie, req.id, item, { decision: "reject", note: "x" })).status).toBe(404);
    const row = (await env.DB_NA.prepare("SELECT status, reject_note FROM items WHERE id = ?").bind(item).first<any>())!;
    expect(row).toEqual({ status: "submitted", reject_note: null });
    const other2 = await (await api("/api/requests", { method: "POST", cookie: other.cookie, body: { client_id: other.client.id, title: "B", deadline: inDays(5), items: [{ label: "x" }] } })).json<any>();
    expect((await review(other.cookie, other2.id, item, { decision: "approve" })).status).toBe(404);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM audit WHERE action IN ('file.view', 'item.review')").first<any>())!.n).toBe(0);
  });
});
