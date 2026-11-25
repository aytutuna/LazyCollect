import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sweepFiles } from "../src/sweep";
import { syncStatus } from "../src/status";
import { HOUR, randomId } from "../src/util";
import { api, openRequest, pdf, review, upload } from "./helpers";

const state = async () => (await env.DB_NA.prepare("SELECT status FROM requests").first<any>())!.status as string;
const counts = async () => ({
  rows: (await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM files").first<{ n: number }>())!.n,
  objects: (await env.FILES_NA.list()).objects.length,
});

async function completeRequest() {
  const o = await openRequest();
  const first = await (await upload(o.path, o.req.items[0].id, pdf(500))).json<any>();
  return { ...o, first };
}

async function addPending(itemId: string, uploadedAt: number, deletedAt: number | null = null, withObject = true) {
  const row = (await env.DB_NA.prepare("SELECT id, firm_id FROM requests").first<any>())!;
  const id = randomId();
  const key = `f/${row.firm_id}/${row.id}/${id}`;
  await env.DB_NA.prepare(
    `INSERT INTO files (id, firm_id, request_id, item_id, r2_key, name, mime, size, upload_id, uploaded_by, uploaded_at, state, deleted_at)
     VALUES (?, ?, ?, ?, ?, 'x.pdf', 'application/pdf', 1, ?, 'client', ?, ?, ?)`,
  )
    .bind(id, row.firm_id, row.id, itemId, key, crypto.randomUUID(), uploadedAt, deletedAt === null ? "pending" : "live", deletedAt)
    .run();
  if (withObject) await env.FILES_NA.put(key, new Uint8Array([1, 2, 3]));
  return { id, key };
}

describe("status sync", () => {
  it("leaves draft, closed and expired requests alone and completes an open one", async () => {
    const { req } = await completeRequest();
    const row = (await env.DB_NA.prepare("SELECT id, firm_id FROM requests").first<any>())!;
    await env.DB_NA.prepare("UPDATE items SET status = 'submitted'").run();
    for (const status of ["draft", "closed", "expired"]) {
      await env.DB_NA.prepare("UPDATE requests SET status = ?").bind(status).run();
      await syncStatus(env.DB_NA, row.firm_id, row.id).run();
      expect(await state()).toBe(status);
    }
    await env.DB_NA.prepare("UPDATE requests SET status = 'open'").run();
    await syncStatus(env.DB_NA, row.firm_id, row.id).run();
    expect(await state()).toBe("complete");
    expect(req.items).toHaveLength(2);
  });

  it("needs a live file, not just submitted items", async () => {
    await completeRequest();
    const row = (await env.DB_NA.prepare("SELECT id, firm_id FROM requests").first<any>())!;
    await env.DB_NA.prepare("UPDATE files SET state = 'pending'").run();
    await env.DB_NA.prepare("UPDATE requests SET status = 'open'").run();
    await syncStatus(env.DB_NA, row.firm_id, row.id).run();
    expect(await state()).toBe("open");
  });

  it("treats a complete request like an open one for edits and links", async () => {
    const { cookie, req } = await completeRequest();
    expect(await state()).toBe("complete");
    const link = await api(`/api/requests/${req.id}/link`, { method: "POST", cookie });
    expect(link.status).toBe(200);
    expect(await state()).toBe("complete");

    const added = await (await api(`/api/requests/${req.id}/items`, { method: "POST", cookie, body: { label: "Extra", required: true } })).json<any>();
    expect(await state()).toBe("open");
    expect((await api(`/api/requests/${req.id}/items/${added.id}`, { method: "PATCH", cookie, body: { required: false } })).status).toBe(200);
    expect(await state()).toBe("complete");
    expect((await api(`/api/requests/${req.id}/items/${added.id}`, { method: "PATCH", cookie, body: { required: true } })).status).toBe(200);
    expect(await state()).toBe("open");
    expect((await api(`/api/requests/${req.id}/items/${added.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect(await state()).toBe("complete");
    expect((await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { title: "New" } })).status).toBe(200);
  });
});

describe("item delete and files", () => {
  it("removes the rows and objects of files the client already removed", async () => {
    const { cookie, req, path, first } = await completeRequest();
    await api(`${path}/files/${first.id}`, { method: "DELETE" });
    await addPending(req.items[0].id, 1, 5, true);
    expect((await api(`/api/requests/${req.id}/items/${req.items[0].id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect(await counts()).toEqual({ rows: 0, objects: 0 });
  });

  it("refuses while an upload is pending", async () => {
    const { cookie, req } = await openRequest();
    const pending = await addPending(req.items[0].id, Date.now());
    const res = await api(`/api/requests/${req.id}/items/${req.items[0].id}`, { method: "DELETE", cookie });
    expect(res.status).toBe(409);
    expect(await counts()).toEqual({ rows: 1, objects: 1 });
    expect(await env.FILES_NA.head(pending.key)).not.toBeNull();
  });
});

describe("sweep", () => {
  it("removes old pending and deleted objects and keeps the rest", async () => {
    const { req, first } = await completeRequest();
    const item = req.items[1].id;
    const stale = await addPending(item, Date.now() - 2 * HOUR);
    const fresh = await addPending(item, Date.now() - 5 * 60_000);
    const removed = await addPending(item, 1, Date.now());
    const noObject = await addPending(item, 1, Date.now(), false);
    await sweepFiles(env);
    const left = (await env.DB_NA.prepare("SELECT id FROM files ORDER BY id").all<{ id: string }>()).results.map((r) => r.id).sort();
    expect(left).toEqual([first.id, fresh.id].sort());
    expect(await env.FILES_NA.head(stale.key)).toBeNull();
    expect(await env.FILES_NA.head(removed.key)).toBeNull();
    expect(await env.FILES_NA.head(noObject.key)).toBeNull();
    expect(await env.FILES_NA.head(fresh.key)).not.toBeNull();
    expect((await env.FILES_NA.list()).objects).toHaveLength(2);
  });

  it("leaves objects of soft-deleted requests alone", async () => {
    const { cookie, req } = await completeRequest();
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    await sweepFiles(env);
    expect(await counts()).toEqual({ rows: 1, objects: 1 });
  });
});

describe("upload edge cases", () => {
  it("leaves nothing behind when the body is shorter than its length", async () => {
    const { req, path } = await openRequest();
    const res = await upload(path, req.items[0].id, pdf(3000), { headers: { "Content-Length": "5000" } }).catch(() => null);
    expect(res === null || res.status >= 400).toBe(true);
    expect(await counts()).toEqual({ rows: 0, objects: 0 });
    expect(await state()).toBe("open");
  });

  it("stops taking uploads once the firm's plan has lapsed, and takes them again after a payment", async () => {
    const { req, path } = await openRequest();
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'canceled', trial_ends_at = 1").run();
    const refused = await upload(path, req.items[0].id, pdf(300));
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: "paused" });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    expect((await upload(path, req.items[0].id, pdf(300))).status).toBe(201);
  });

  it("answers HEAD on a file with 405, no decrypt and no audit row", async () => {
    const { cookie, first } = await completeRequest();
    const res = await api(`/api/files/${first.id}`, { method: "HEAD", cookie });
    expect(res.status).toBe(405);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'file.view'").first<any>())!.n).toBe(0);
  });
});

describe("review of what was seen", () => {
  it("answers 409 stale when the file set changed", async () => {
    const { cookie, req, path, first } = await completeRequest();
    const item = req.items[0].id;
    const seen = [first.id];
    await upload(path, item, pdf(400));
    const res = await review(cookie, req.id, item, { decision: "approve", files: seen });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale" });
    expect((await env.DB_NA.prepare("SELECT status FROM items WHERE id = ?").bind(item).first<any>())!.status).toBe("submitted");
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'item.review'").first<any>())!.n).toBe(0);
    expect((await review(cookie, req.id, item, { decision: "approve" })).status).toBe(200);
  });

  it("answers 409 stale after a removal and when a file is missing from the list", async () => {
    const { cookie, req, path, first } = await completeRequest();
    const item = req.items[0].id;
    const second = await (await upload(path, item, pdf(400))).json<any>();
    expect((await review(cookie, req.id, item, { decision: "approve", files: [first.id] })).status).toBe(409);
    await api(`${path}/files/${second.id}`, { method: "DELETE" });
    expect((await review(cookie, req.id, item, { decision: "approve", files: [first.id, second.id] })).status).toBe(409);
    expect((await review(cookie, req.id, item, { decision: "reject", note: "x", files: [] })).status).toBe(409);
    expect((await review(cookie, req.id, item, { decision: "approve", files: [first.id] })).status).toBe(200);
  });

  it("needs the file list", async () => {
    const { cookie, req, first } = await completeRequest();
    const send = (body: unknown) => api(`/api/requests/${req.id}/items/${req.items[0].id}/review`, { method: "POST", cookie, body });
    expect((await send({ decision: "approve" })).status).toBe(400);
    expect((await send({ decision: "approve", files: "x" })).status).toBe(400);
    expect((await send({ decision: "approve", files: [1] })).status).toBe(400);
    expect((await send({ decision: "approve", files: [first.id, first.id] })).status).toBe(200);
  });
});
