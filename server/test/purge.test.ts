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
  it("moves a finished request to Recently deleted first and purges it 30 days later", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    const keep = (await env.DB_NA.prepare("SELECT keep_until FROM requests").first<any>())!.keep_until;
    await purgeExpired(env, keep - 1);
    expect(await count("requests", "deleted_at IS NULL")).toBe(1);

    await purgeExpired(env, keep);
    expect(await env.DB_NA.prepare("SELECT deleted_at, deleted_reason FROM requests").first<any>()).toEqual({ deleted_at: keep, deleted_reason: "retention" });
    expect([await count("requests"), await objects()]).toEqual([1, 3]);
    const audited = (await env.DB_NA.prepare("SELECT actor_type, object_id FROM audit WHERE action = 'request.retention_delete'").all<any>()).results;
    expect(audited).toEqual([{ actor_type: "system", object_id: req.id }]);
    const listed = await (await api("/api/trash", { cookie })).json<any>();
    expect(listed.requests[0]).toMatchObject({ id: req.id, deleted_reason: "retention" });

    await purgeExpired(env, keep + RESTORE_WINDOW - 1);
    expect(await count("requests")).toBe(1);
    await purgeExpired(env, keep + RESTORE_WINDOW);
    expect([await count("requests"), await objects()]).toEqual([0, 0]);
    expect((await log())[0]).toMatchObject({ kind: "request", reason: "retention", files: 3 });
    expect(await count("clients")).toBe(1);
  });

  it("starts a fresh clock when a retention deletion is restored", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    const keep = (await env.DB_NA.prepare("SELECT keep_until FROM requests").first<any>())!.keep_until;
    await purgeExpired(env, keep);
    expect((await api(`/api/requests/${req.id}/restore`, { method: "POST", cookie })).status).toBe(200);
    const row = (await env.DB_NA.prepare("SELECT deleted_at, deleted_reason, ended_at, keep_until FROM requests").first<any>())!;
    expect(row).toMatchObject({ deleted_at: null, deleted_reason: null });
    expect(row.keep_until).toBeGreaterThan(Date.now() + 6 * 365 * DAY);
    await purgeExpired(env, Date.now() + 40 * DAY);
    expect(await count("requests", "deleted_at IS NULL")).toBe(1);
  });

  it("leaves a completed request alone while its link is still live", async () => {
    await withFiles();
    await env.DB_NA.prepare("UPDATE requests SET keep_until = 1").run();
    expect((await env.DB_NA.prepare("SELECT status FROM requests").first<any>())!.status).toBe("complete");
    await purgeExpired(env);
    expect(await count("requests", "deleted_at IS NULL")).toBe(1);
    // once the deadline and the link grace are behind us it counts as finished
    await env.DB_NA.prepare("UPDATE requests SET deadline = ?").bind(Date.now() - 60 * DAY).run();
    await purgeExpired(env);
    expect(await count("requests", "deleted_at IS NULL")).toBe(0);
  });

  it("skips a request on legal hold until it is released", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: true } });
    const later = Date.now() + 20 * 365 * DAY;
    await purgeExpired(env, later);
    await purgeExpired(env, later + RESTORE_WINDOW);
    expect([await count("requests"), await count("requests", "deleted_at IS NULL"), await objects()]).toEqual([1, 1, 3]);
    await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: false } });
    await purgeExpired(env, later);
    expect(await count("requests", "deleted_at IS NULL")).toBe(0);
    await purgeExpired(env, later + RESTORE_WINDOW);
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

describe("purge claims and failures", () => {
  const retired = async () => {
    const o = await withFiles();
    await api(`/api/requests/${o.req.id}`, { method: "DELETE", cookie: o.cookie });
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1").run();
    return o;
  };

  it("does not touch a request another run has claimed, and reclaims a stale claim", async () => {
    await retired();
    const now = Date.now();
    await env.DB_NA.prepare("UPDATE requests SET purging_at = ?").bind(now - 60_000).run();
    await purgeExpired(env, now);
    expect([await count("requests"), await objects()]).toEqual([1, 3]);
    await purgeExpired(env, now + 2 * 3_600_000);
    expect([await count("requests"), await objects()]).toEqual([0, 0]);
  });

  it("refuses restore, hold and client restore while a purge has the request", async () => {
    const { cookie, req } = await retired();
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = ?, purging_at = ?").bind(Date.now(), Date.now()).run();
    const restore = await api(`/api/requests/${req.id}/restore`, { method: "POST", cookie });
    expect([restore.status, await restore.json()]).toEqual([409, { error: "purging" }]);
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = NULL").run();
    const hold = await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: true } });
    expect([hold.status, await hold.json()]).toEqual([409, { error: "purging" }]);
    expect((await env.DB_NA.prepare("SELECT hold_at FROM requests").first<any>())!.hold_at).toBeNull();
    await env.DB_NA.prepare("UPDATE clients SET deleted_at = ?").bind(Date.now()).run();
    expect((await api(`/api/clients/${req.client_id}/restore`, { method: "POST", cookie })).status).toBe(409);
  });

  it("releases the claim when the failure comes before any object is touched", async () => {
    const { req } = await retired();
    const broken = { ...env, FILES_NA: { list: () => Promise.reject(new Error("r2 down")), delete: () => Promise.resolve() } } as unknown as Env;
    await purgeExpired(broken, Date.now());
    expect(await env.DB_NA.prepare("SELECT id, purging_at, purge_failed_at IS NOT NULL AS failed FROM requests").first()).toEqual({ id: req.id, purging_at: null, failed: 1 });
  });

  it("logs a client purge's request with its own reason", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/clients/${req.client_id}`, { method: "DELETE", cookie });
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1, deleted_reason = 'retention'").run();
    await env.DB_NA.prepare("UPDATE clients SET deleted_at = 1").run();
    await purgeExpired(env);
    expect((await log()).map((l) => [l.kind, l.reason])).toEqual([["request", "retention"], ["client", "deleted"]]);
  });

  it("keeps what was sent without any address or text", async () => {
    await retired();
    const row = (await env.DB_NA.prepare("SELECT id, firm_id, client_id FROM requests").first<any>())!;
    await env.DB_NA.prepare(
      `INSERT INTO messages (id, firm_id, request_id, client_id, channel, kind, seq, template_version, body_hash, provider_id, status, error, sent_at)
       VALUES (?, ?, ?, ?, 'email', 'reminder', 1, 2, 'abc123', 'prov', 'failed', 'bounced amy@mail.test', 1700000000000)`,
    ).bind("m".repeat(32), row.firm_id, row.id, row.client_id).run();
    await purgeExpired(env);
    expect(await count("messages")).toBe(0);
    expect(await env.DB_NA.prepare("SELECT kind, channel, status, seq, template_version, body_hash, sent_at FROM message_log").first()).toEqual({
      kind: "reminder", channel: "email", status: "failed", seq: 1, template_version: 2, body_hash: "abc123", sent_at: 1700000000000,
    });
    for (const table of ["message_log", "messages", "audit", "deletion_log"]) {
      const dump = JSON.stringify((await env.DB_NA.prepare(`SELECT * FROM ${table}`).all()).results);
      expect([table, dump.includes("@")]).toEqual([table, false]);
    }
  });

  it("carries on past a request that fails and retries it later", async () => {
    const a = await retired();
    const b = await openRequest("other@firm.test");
    await api(`/api/requests/${b.req.id}`, { method: "DELETE", cookie: b.cookie });
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1").run();
    await env.DB_NA.prepare(`CREATE TRIGGER boom BEFORE DELETE ON items WHEN old.request_id = '${a.req.id}' BEGIN SELECT RAISE(ABORT, 'boom'); END`).run();
    const now = Date.now();
    await purgeExpired(env, now);
    expect((await env.DB_NA.prepare("SELECT id, purging_at, purge_failed_at FROM requests").all<any>()).results).toEqual([
      { id: a.req.id, purging_at: now, purge_failed_at: now },
    ]);
    await env.DB_NA.prepare("DROP TRIGGER boom").run();
    await purgeExpired(env, now + 60_000);
    expect(await count("requests")).toBe(1);
    // the claim was kept after the objects went, and the stale-claim retry finishes it
    await purgeExpired(env, now + 2 * 3_600_000);
    expect(await count("requests")).toBe(0);
  });
});
