import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeExpired } from "../src/purge";
import { DAY, RESTORE_WINDOW } from "../src/util";
import { api, inDays, jpeg, openRequest, pdf, setup, upload } from "./helpers";

const count = async (table: string, where = "1") => (await env.DB_NA.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n;
const objects = async () => (await env.FILES_NA.list()).objects.length;
const log = async () => (await env.DB_NA.prepare("SELECT kind, reason, files, target_id, firm_id FROM deletion_log ORDER BY rowid").all<any>()).results;

async function withFiles() {
  const o = await openRequest();
  const [a, b] = o.req.items;
  await upload(o.path, a.id, pdf(2000), { name: "a.pdf" });
  await upload(o.path, a.id, jpeg(900), { name: "b.jpg" });
  await upload(o.path, b.id, pdf(100), { name: "c.pdf" });
  return o;
}

describe("purge of deleted requests", () => {
  it("removes a request and everything under it once 30 days have passed", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    const deletedAt = (await env.DB_NA.prepare("SELECT deleted_at FROM requests").first<any>())!.deleted_at;
    expect(await objects()).toBe(3);

    await purgeExpired(env, deletedAt + RESTORE_WINDOW - 1);
    expect([await count("requests"), await objects()]).toEqual([1, 3]);

    await purgeExpired(env, deletedAt + RESTORE_WINDOW);
    for (const t of ["requests", "items", "files", "links", "messages"]) expect([t, await count(t)]).toEqual([t, 0]);
    expect(await objects()).toBe(0);
    expect(await count("clients")).toBe(1);
    const firmId = (await env.CONTROL.prepare("SELECT id FROM firms").first<any>())!.id;
    expect(await log()).toEqual([{ kind: "request", reason: "deleted", files: 3, target_id: req.id, firm_id: firmId }]);
  });

  it("keeps audit rows and writes a log without personal data", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1").run();
    const before = await count("audit");
    await purgeExpired(env, Date.now());
    expect(await count("audit")).toBe(before);
    const text = JSON.stringify((await env.DB_NA.prepare("SELECT * FROM audit").all()).results) + JSON.stringify(await log());
    for (const word of ["Amy", "amy@mail.test", "Passport", "Visa", "2025 taxes", "owner@firm.test", ".pdf", ".jpg"]) {
      expect([word, text.includes(word)]).toEqual([word, false]);
    }
  });

  it("finishes a run that died after the objects were removed", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1").run();
    const keys = (await env.DB_NA.prepare("SELECT r2_key FROM files").all<any>()).results.map((r) => r.r2_key);
    await env.FILES_NA.delete(keys.slice(0, 2));
    await purgeExpired(env);
    await purgeExpired(env);
    expect([await count("requests"), await count("files"), await objects()]).toEqual([0, 0, 0]);
    expect(await log()).toHaveLength(1);
  });

  it("also takes objects that have no row, such as an upload that lost a race", async () => {
    const { cookie, req } = await withFiles();
    const firmId = (await env.CONTROL.prepare("SELECT id FROM firms").first<any>())!.id;
    await env.FILES_NA.put(`f/${firmId}/${req.id}/stray`, new Uint8Array([1]));
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1").run();
    await purgeExpired(env);
    expect(await objects()).toBe(0);
  });

  it("leaves other requests and the next firm's objects alone", async () => {
    const { cookie, req } = await withFiles();
    const other = await openRequest("other@firm.test");
    await upload(other.path, other.req.items[0].id, pdf(50));
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1 WHERE id = ?").bind(req.id).run();
    await purgeExpired(env);
    expect([await count("requests"), await count("files"), await objects()]).toEqual([1, 1, 1]);
  });

  it("does only a bounded number of requests per run", async () => {
    const { cookie, client } = await setup();
    for (let i = 0; i < 25; i++) {
      await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: `R${i}`, deadline: inDays(3) } });
    }
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1").run();
    await purgeExpired(env);
    expect(await count("requests")).toBe(5);
    await purgeExpired(env);
    expect(await count("requests")).toBe(0);
    expect(await count("deletion_log")).toBe(25);
  });
});

describe("purge by retention", () => {
  it("removes a finished request once keep_until has passed, not before", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    const keep = (await env.DB_NA.prepare("SELECT keep_until FROM requests").first<any>())!.keep_until;
    await purgeExpired(env, keep - 1);
    expect(await count("requests")).toBe(1);
    await purgeExpired(env, keep);
    expect([await count("requests"), await objects()]).toEqual([0, 0]);
    expect((await log())[0]).toMatchObject({ kind: "request", reason: "retention", files: 3 });
    expect(await count("clients")).toBe(1);
  });

  it("skips a request on legal hold until it is released", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: true } });
    const later = Date.now() + 20 * 365 * DAY;
    await purgeExpired(env, later);
    expect([await count("requests"), await objects()]).toEqual([1, 3]);
    await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: false } });
    await purgeExpired(env, later);
    expect(await count("requests")).toBe(0);
  });

  it("leaves open requests and ones still inside the window", async () => {
    const { cookie, req } = await openRequest();
    await purgeExpired(env, Date.now() + 20 * 365 * DAY);
    expect(await count("requests")).toBe(1);
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    await purgeExpired(env, Date.now() + 6 * 365 * DAY);
    expect(await count("requests")).toBe(1);
  });

  it("does not let retention take a deleted request still inside its restore window", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    await env.DB_NA.prepare("UPDATE requests SET keep_until = 1").run();
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = ?").bind(Date.now()).run();
    await purgeExpired(env, Date.now() + DAY);
    expect(await count("requests")).toBe(1);
  });
});

describe("purge of deleted clients", () => {
  it("takes the client with all of its requests after 30 days", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/clients/${req.client_id}`, { method: "DELETE", cookie });
    const at = (await env.DB_NA.prepare("SELECT deleted_at FROM clients").first<any>())!.deleted_at;
    await purgeExpired(env, at + RESTORE_WINDOW - 1);
    expect([await count("clients"), await count("requests")]).toEqual([1, 1]);
    await purgeExpired(env, at + RESTORE_WINDOW);
    expect([await count("clients"), await count("requests"), await count("files"), await objects()]).toEqual([0, 0, 0, 0]);
    expect((await log()).map((l) => [l.kind, l.reason, l.files])).toEqual([["request", "deleted", 3], ["client", "deleted", 3]]);
  });

  it("keeps a held request and its client, and purges the rest", async () => {
    const { cookie, req } = await withFiles();
    const second = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: req.client_id, title: "Second", deadline: inDays(3) } })).json<any>();
    await api(`/api/requests/${second.id}/hold`, { method: "PUT", cookie, body: { on: true } });
    await api(`/api/requests/${second.id}/close`, { method: "POST", cookie });
    await env.DB_NA.prepare("UPDATE clients SET deleted_at = 1").run();
    await purgeExpired(env);
    expect((await env.DB_NA.prepare("SELECT id FROM requests").all<any>()).results.map((r) => r.id)).toEqual([second.id]);
    expect(await count("clients")).toBe(1);
    await purgeExpired(env);
    expect(await count("clients")).toBe(1);
    await api(`/api/requests/${second.id}/hold`, { method: "PUT", cookie, body: { on: false } });
    await purgeExpired(env);
    expect([await count("clients"), await count("requests")]).toEqual([0, 0]);
  });

  it("does not purge a client deleted less than 30 days ago", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/clients/${req.client_id}`, { method: "DELETE", cookie });
    await purgeExpired(env, Date.now() + 29 * DAY);
    expect(await count("clients")).toBe(1);
  });
});
