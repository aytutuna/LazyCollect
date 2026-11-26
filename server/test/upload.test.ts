import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, jpeg, openRequest, pdf, randomBytes, review, sha, upload } from "./helpers";

const png = (n: number) => Object.assign(randomBytes(n), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const counts = async () => ({
  rows: (await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM files").first<{ n: number }>())!.n,
  objects: (await env.FILES_NA.list({ prefix: "f/" })).objects.length,
});

describe("client upload", () => {
  it("stores a pdf, marks the item submitted and lists the file", async () => {
    const { req, path } = await openRequest();
    const item = req.items[0].id;
    const body = pdf(5000);
    const res = await upload(path, item, body, { name: "Passport scan.pdf" });
    expect(res.status).toBe(201);
    const file = await res.json<any>();
    expect(file).toMatchObject({ name: "Passport scan.pdf", size: 5000 });
    const row = (await env.DB_NA.prepare("SELECT * FROM files").first<any>())!;
    expect(row).toMatchObject({ id: file.id, item_id: item, mime: "application/pdf", uploaded_by: "client", size: 5000, deleted_at: null });
    expect(row.r2_key).toBe(`f/${row.firm_id}/${req.id}/${file.id}`);
    expect((await env.FILES_NA.head(row.r2_key))).not.toBeNull();

    const view = await (await api(path)).json<any>();
    expect(view.items[0].status).toBe("submitted");
    expect(view.items[0].files).toEqual([{ id: file.id, name: "Passport scan.pdf", size: 5000, uploaded_at: file.uploaded_at, sent_back_at: null }]);
    expect(view.items[1].files).toEqual([]);
  });

  it("takes the type from the bytes, not the header", async () => {
    const { req, path } = await openRequest();
    const res = await upload(path, req.items[0].id, png(300), { name: "x.pdf", headers: { "Content-Type": "application/pdf" } });
    expect(res.status).toBe(201);
    expect((await env.DB_NA.prepare("SELECT mime FROM files").first<any>())!.mime).toBe("image/png");
  });

  it.each([
    ["jpeg", jpeg(100), "image/jpeg"],
    ["webp", randomBytes(100, "RIFF\0\0\0\0WEBPVP8 "), "image/webp"],
    ["heic", Object.assign(randomBytes(100), [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]), "image/heic"],
    ["heif", Object.assign(randomBytes(100), [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31]), "image/heif"],
  ])("accepts %s", async (_n, body, mime) => {
    const { req, path } = await openRequest();
    expect((await upload(path, req.items[0].id, body)).status).toBe(201);
    expect((await env.DB_NA.prepare("SELECT mime FROM files").first<any>())!.mime).toBe(mime);
  });

  it.each([
    ["text", new TextEncoder().encode("hello, not a document")],
    ["gif", randomBytes(100, "GIF89a")],
    ["html", new TextEncoder().encode("<html><script>alert(1)</script>")],
    ["zip", randomBytes(100, "PK\x03\x04")],
    ["avif", Object.assign(randomBytes(100), [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])],
    ["empty", new Uint8Array(0)],
    ["two bytes", new Uint8Array([0xff, 0xd8])],
  ])("answers 415 for %s and stores nothing", async (_n, body) => {
    const { req, path } = await openRequest();
    const res = await upload(path, req.items[0].id, body, { headers: { "Content-Type": "image/jpeg" } });
    expect(res.status).toBe(415);
    expect(await counts()).toEqual({ rows: 0, objects: 0 });
    expect((await api(path).then((r) => r.json<any>())).items[0].status).toBe("empty");
  });

  it("answers 411 without a length and 413 over 25 MB", async () => {
    const { req, path } = await openRequest();
    const item = req.items[0].id;
    const chunked = new ReadableStream({ start: (c) => (c.enqueue(pdf(100)), c.close()) });
    expect((await upload(path, item, chunked, { omit: ["Content-Length"] })).status).toBe(411);
    expect((await upload(path, item, pdf(25 * 1024 * 1024 + 1))).status).toBe(413);
    expect(await counts()).toEqual({ rows: 0, objects: 0 });
  });

  it("accepts exactly 25 MB", async () => {
    const { req, path } = await openRequest();
    const body = pdf(25 * 1024 * 1024);
    expect((await upload(path, req.items[0].id, body)).status).toBe(201);
    expect((await env.FILES_NA.list({ prefix: "f/" })).objects[0].size).toBeGreaterThan(body.length);
  });

  it("rejects a bad Upload-Id or file name", async () => {
    const { req, path } = await openRequest();
    const item = req.items[0].id;
    expect((await upload(path, item, pdf(50), { uploadId: "nope" })).status).toBe(400);
    expect((await upload(path, item, pdf(50), { omit: ["Upload-Id"] })).status).toBe(400);
    expect((await upload(path, item, pdf(50), { headers: { "X-File-Name": "%E0%A4%A" } })).status).toBe(400);
    expect(await counts()).toEqual({ rows: 0, objects: 0 });
  });

  it("returns the same file for a repeated Upload-Id", async () => {
    const { req, path } = await openRequest();
    const item = req.items[0].id;
    const uploadId = crypto.randomUUID();
    const first = await upload(path, item, pdf(1000), { uploadId });
    const again = await upload(path, item, pdf(1000), { uploadId });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect((await again.json<any>()).id).toBe((await first.json<any>()).id);
    expect(await counts()).toEqual({ rows: 1, objects: 1 });
  });

  it("keeps one file when the same upload arrives twice at once", async () => {
    const { req, path } = await openRequest();
    const uploadId = crypto.randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => upload(path, req.items[0].id, pdf(70_000), { uploadId })));
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain(201);
    expect(statuses.every((s) => s === 201 || s === 200 || s === 409)).toBe(true);
    const bodies = await Promise.all(results.map((r) => r.json<any>()));
    expect(new Set(bodies.filter((b) => b.id).map((b) => b.id)).size).toBe(1);
    expect(bodies.filter((b) => b.error).every((b) => b.error === "busy")).toBe(true);
    expect(await counts()).toEqual({ rows: 1, objects: 1 });
  });

  it("does not reuse the Upload-Id of a removed file", async () => {
    const { req, path } = await openRequest();
    const uploadId = crypto.randomUUID();
    const file = await (await upload(path, req.items[0].id, pdf(100), { uploadId })).json<any>();
    await api(`${path}/files/${file.id}`, { method: "DELETE" });
    expect((await upload(path, req.items[0].id, pdf(100), { uploadId })).status).toBe(409);
    expect(await counts()).toEqual({ rows: 1, objects: 0 });
  });

  it("answers 404 for an item of another request", async () => {
    const { cookie, req, path } = await openRequest();
    const client = (await env.DB_NA.prepare("SELECT client_id FROM requests").first<any>())!.client_id;
    const other = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client, title: "Other", deadline: Date.now() + 86_400_000, items: [{ label: "x" }] } })).json<any>();
    expect((await upload(path, other.items[0].id, pdf(100))).status).toBe(404);
    expect((await upload(path, "0".repeat(32), pdf(100))).status).toBe(404);
    expect((await upload(path, req.items[0].id, pdf(100))).status).toBe(201);
    expect(await counts()).toEqual({ rows: 1, objects: 1 });
  });

  it("answers 404 for dead links and requests", async () => {
    const { cookie, req, path } = await openRequest();
    const item = req.items[0].id;
    expect((await upload("/api/c/garbage", item, pdf(100))).status).toBe(404);
    expect((await upload(`${path.slice(0, -1)}${path.endsWith("A") ? "B" : "A"}`, item, pdf(100))).status).toBe(404);
    await env.DB_NA.prepare("UPDATE links SET expires_at = ?").bind(Date.now() - 1).run();
    expect((await upload(path, item, pdf(100))).status).toBe(404);
    await env.DB_NA.prepare("UPDATE links SET expires_at = ?").bind(Date.now() + 86_400_000).run();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    expect((await upload(path, item, pdf(100))).status).toBe(404);
    expect(await counts()).toEqual({ rows: 0, objects: 0 });
    await env.DB_NA.batch([
      env.DB_NA.prepare("UPDATE requests SET status = 'open', closed_at = NULL"),
      env.DB_NA.prepare("UPDATE links SET revoked_at = NULL"),
    ]);
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1").run();
    expect((await upload(path, item, pdf(100))).status).toBe(404);
  });

  it("refuses an approved item", async () => {
    const { cookie, req, path } = await openRequest();
    const item = req.items[0].id;
    await upload(path, item, pdf(100));
    await review(cookie, req.id, item, { decision: "approve" });
    const res = await upload(path, item, pdf(100));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "approved" });
    expect(await counts()).toEqual({ rows: 1, objects: 1 });
  });

  it("caps live files at 20 per item", async () => {
    const { req, path } = await openRequest();
    const item = req.items[0].id;
    for (let i = 0; i < 20; i++) expect((await upload(path, item, pdf(50 + i))).status).toBe(201);
    const res = await upload(path, item, pdf(100));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "limit" });
    expect(await counts()).toEqual({ rows: 20, objects: 20 });
    expect((await upload(path, req.items[1].id, pdf(100))).status).toBe(201);
  });

  it("frees a slot when a file is removed", async () => {
    const { req, path } = await openRequest();
    const item = req.items[0].id;
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await (await upload(path, item, pdf(50 + i))).json<any>()).id);
    await api(`${path}/files/${ids[0]}`, { method: "DELETE" });
    expect((await upload(path, item, pdf(100))).status).toBe(201);
  });

  it("caps live files at 300 per request", async () => {
    const { req, path } = await openRequest();
    const row = (await env.DB_NA.prepare("SELECT id, firm_id FROM requests").first<any>())!;
    await env.DB_NA.prepare(
      `INSERT INTO files (id, firm_id, request_id, item_id, r2_key, name, mime, size, upload_id, uploaded_by, uploaded_at)
       SELECT lower(hex(randomblob(16))), ?, ?, ?, 'x', 'x', 'application/pdf', 1, lower(hex(randomblob(16))), 'client', 1
       FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) SELECT i FROM n)`,
    )
      .bind(row.firm_id, row.id, req.items[1].id)
      .run();
    const res = await upload(path, req.items[0].id, pdf(100));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "limit" });
    expect((await env.FILES_NA.list({ prefix: "f/" })).objects).toHaveLength(0);
  });

  it("answers 429 past 30 uploads a minute on one link", async () => {
    const { req, path } = await openRequest();
    const statuses: number[] = [];
    for (let i = 0; i < 34; i++) statuses.push((await upload(path, req.items[1].id, pdf(20))).status);
    expect(statuses).toContain(429);
    expect(statuses.indexOf(429)).toBeGreaterThanOrEqual(30);
  });

  it("cleans file names", async () => {
    const { req, path } = await openRequest();
    const item = req.items[0].id;
    const names = ["../../etc/pa\u0000ss\u202ewd.pdf", "a".repeat(300), "   ", "...hidden.pdf", "C:\\dir\\file?.pdf", "résumé 📄.pdf"];
    for (const name of names) expect((await upload(path, item, pdf(60), { name })).status).toBe(201);
    const { results } = await env.DB_NA.prepare("SELECT name FROM files ORDER BY uploaded_at, rowid").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["_.._etc_passwd.pdf", "a".repeat(196) + ".pdf", "file.pdf", "hidden.pdf", "C__dir_file_.pdf", "résumé 📄.pdf"]);
  });

  it.each([
    ["T4.pdf.html", pdf(60), "T4.pdf"],
    ["report.v2", pdf(60), "report.pdf"],
    ["scan", pdf(60), "scan.pdf"],
    ["IMG.JPG", jpeg(60), "IMG.JPG"],
    ["photo.png", jpeg(60), "photo.jpg"],
    ["page.exe", png(60), "page.png"],
    [`${"b".repeat(250)}.pdf.js`, pdf(60), `${"b".repeat(196)}.pdf`],
  ])("names %s after what the bytes are", async (name, body, want) => {
    const { req, path } = await openRequest();
    expect((await upload(path, req.items[0].id, body, { name })).status).toBe(201);
    expect((await env.DB_NA.prepare("SELECT name FROM files").first<any>())!.name).toBe(want);
  });

  it("writes an audit row for the upload", async () => {
    const { req, path } = await openRequest();
    const file = await (await upload(path, req.items[0].id, pdf(321))).json<any>();
    const row = (await env.DB_NA.prepare("SELECT * FROM audit WHERE action = 'file.upload'").first<any>())!;
    expect(row).toMatchObject({ actor_type: "client", actor_id: null, object_type: "file", object_id: file.id });
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(row.meta)).toMatchObject({ request: req.id, item: req.items[0].id, size: 321, mime: "application/pdf" });
  });
});

describe("request status", () => {
  const status = async (path: string) => (await (await api(path)).json<any>()).status;

  it("turns complete once every required item has a file and open again after a removal", async () => {
    const { req, path } = await openRequest();
    expect(await status(path)).toBe("open");
    await upload(path, req.items[1].id, pdf(100));
    expect(await status(path)).toBe("open");
    const file = await (await upload(path, req.items[0].id, pdf(100))).json<any>();
    expect(await status(path)).toBe("complete");
    expect((await upload(path, req.items[0].id, pdf(120))).status).toBe(201);
    expect((await api(`${path}/files/${file.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await status(path)).toBe("complete");
    const left = (await (await api(path)).json<any>()).items[0].files[0];
    await api(`${path}/files/${left.id}`, { method: "DELETE" });
    expect(await status(path)).toBe("open");
  });

  it("goes back to open on a rejection and complete again after a new upload", async () => {
    const { cookie, req, path } = await openRequest();
    const item = req.items[0].id;
    await upload(path, item, pdf(100));
    expect(await status(path)).toBe("complete");
    await review(cookie, req.id, item, { decision: "reject", note: "Too dark" });
    expect(await status(path)).toBe("open");
    expect((await (await api(path)).json<any>()).items[0]).toMatchObject({ status: "rejected", reject_note: "Too dark" });
    await upload(path, item, pdf(110));
    const view = await (await api(path)).json<any>();
    expect(view.status).toBe("complete");
    expect(view.items[0]).toMatchObject({ status: "submitted", reject_note: "Too dark" });
  });

  it("leaves closed and draft requests alone", async () => {
    const { cookie, req, path } = await openRequest();
    await upload(path, req.items[0].id, pdf(100));
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    expect((await env.DB_NA.prepare("SELECT status FROM requests").first<any>())!.status).toBe("closed");
  });

  it("does not complete a request with no items", async () => {
    const { cookie } = await openRequest();
    const client = (await env.DB_NA.prepare("SELECT client_id FROM requests").first<any>())!.client_id;
    const empty = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client, title: "Empty", deadline: Date.now() + 86_400_000 } })).json<any>();
    await api(`/api/requests/${empty.id}/link`, { method: "POST", cookie });
    expect((await env.DB_NA.prepare("SELECT status FROM requests WHERE id = ?").bind(empty.id).first<any>())!.status).toBe("open");
  });
});

describe("client delete", () => {
  it("removes the object, flags the row, empties the item and audits", async () => {
    const { req, path } = await openRequest();
    const item = req.items[0].id;
    const file = await (await upload(path, item, pdf(100))).json<any>();
    const res = await api(`${path}/files/${file.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await counts()).toEqual({ rows: 1, objects: 0 });
    const row = (await env.DB_NA.prepare("SELECT deleted_at FROM files").first<any>())!;
    expect(row.deleted_at).toBeGreaterThan(0);
    const view = await (await api(path)).json<any>();
    expect(view.items[0]).toMatchObject({ status: "empty", files: [] });
    const a = (await env.DB_NA.prepare("SELECT * FROM audit WHERE action = 'file.delete'").first<any>())!;
    expect(a).toMatchObject({ actor_type: "client", object_id: file.id });
    expect((await api(`${path}/files/${file.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("keeps the item submitted while other files remain", async () => {
    const { req, path } = await openRequest();
    const item = req.items[0].id;
    const a = await (await upload(path, item, pdf(100))).json<any>();
    await upload(path, item, pdf(120));
    await api(`${path}/files/${a.id}`, { method: "DELETE" });
    expect((await (await api(path)).json<any>()).items[0].status).toBe("submitted");
  });

  it("refuses an approved item's file", async () => {
    const { cookie, req, path } = await openRequest();
    const item = req.items[0].id;
    const file = await (await upload(path, item, pdf(100))).json<any>();
    await review(cookie, req.id, item, { decision: "approve" });
    const res = await api(`${path}/files/${file.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await counts()).toEqual({ rows: 1, objects: 1 });
  });

  it("will not touch files of another link, firm uploads or unknown ids", async () => {
    const one = await openRequest("one@firm.test");
    const two = await openRequest("two@firm.test");
    const file = await (await upload(one.path, one.req.items[0].id, pdf(100))).json<any>();
    expect((await api(`${two.path}/files/${file.id}`, { method: "DELETE" })).status).toBe(404);
    await env.DB_NA.prepare("UPDATE files SET uploaded_by = 'user'").run();
    expect((await api(`${one.path}/files/${file.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await api(`${one.path}/files/${"0".repeat(32)}`, { method: "DELETE" })).status).toBe(404);
    expect(await counts()).toEqual({ rows: 1, objects: 1 });
    expect((await upload(two.path, two.req.items[0].id, pdf(100))).status).toBe(201);
  });

  it("needs the X-Collect header", async () => {
    const { req, path } = await openRequest();
    const file = await (await upload(path, req.items[0].id, pdf(100))).json<any>();
    const res = await api(`${path}/files/${file.id}`, { method: "DELETE", headers: { "X-Collect": "0" } });
    expect(res.status).toBe(403);
  });

  it("serves the firm a download with a safe header", async () => {
    const { cookie, req, path } = await openRequest();
    const body = jpeg(90_000);
    const file = await (await upload(path, req.items[0].id, body, { name: "résumé (1).jpg" })).json<any>();
    const res = await api(`/api/files/${file.id}`, { cookie });
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="r_sum_ (1).jpg"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.jpg`);
    expect(await sha(await res.arrayBuffer())).toBe(await sha(body));
  });
});
