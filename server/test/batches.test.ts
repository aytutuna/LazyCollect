import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeClosed } from "../src/account";
import { runBatches } from "../src/batches";
import { purgeExpired } from "../src/purge";
import { atHour } from "../src/tz";
import { DAY, HOUR, MINUTE, randomId } from "../src/util";
import { api, firmRow, inDays, login, mockOutbound } from "./helpers";

const TZ = "America/Toronto";
const at = (y: number, m: number, d: number, h: number, min = 0) => atHour({ y, m, d }, h, TZ) + min * MINUTE;
// a Tuesday morning inside sending hours, before the deadlines these tests use
const NOW = at(2027, 1, 12, 10);
const ADDRESS = "12 King St W\nToronto ON M5H 1A1";

async function ready(n = 3, email = "owner@firm.test", plan = "active") {
  const cookie = await login(email);
  await api("/api/firm", { method: "PATCH", cookie, body: { name: "Tuna Tax", address: ADDRESS } });
  await env.CONTROL.prepare("UPDATE firms SET plan_status = ? WHERE id = (SELECT firm_id FROM users WHERE email = ?)").bind(plan, email).run();
  const ids = await addClients(cookie, n);
  return { cookie, ids };
}

async function addClients(cookie: string, n: number, from = 0): Promise<string[]> {
  const rows = Array.from({ length: n }, (_, i) => ({ name: `Client ${from + i}`, email: `c${from + i}@mail.test` }));
  for (let at = 0; at < rows.length; at += 200) {
    const res = await api("/api/clients/import", { method: "POST", cookie, body: { rows: rows.slice(at, at + 200), import_id: randomId(), contact_ok: true } });
    expect(res.status).toBe(200);
  }
  const firm = await firmRow(cookie);
  return (await env.DB_NA.prepare("SELECT id FROM clients WHERE firm_id = ? ORDER BY name").bind(firm.id).all<{ id: string }>()).results.map((r) => r.id);
}

const body = (ids: string[], extra: Record<string, unknown> = {}) => ({
  template_id: "t1-personal",
  client_ids: ids,
  title: "{year} taxes for {client}",
  deadline: inDays(400),
  reminders_on: true,
  ...extra,
});
const create = (cookie: string, b: unknown) => api("/api/batches", { method: "POST", cookie, body: b });
const one = (id: string, cookie: string) => api(`/api/batches/${id}`, { cookie }).then((r) => r.json<any>());
const q = <T = any>(sql: string, ...binds: unknown[]) => env.DB_NA.prepare(sql).bind(...binds).all<T>().then((r) => r.results);

describe("creating a batch", () => {
  it("answers 401 without a session", async () => {
    expect((await api("/api/batches")).status).toBe(401);
    expect((await api("/api/batches", { method: "POST", body: {} })).status).toBe(401);
  });

  it("makes a draft with the items for every client and sends nothing", async () => {
    const { cookie, ids } = await ready(3);
    const sent = mockOutbound();
    const res = await create(cookie, body(ids));
    expect(res.status).toBe(201);
    const batch = await res.json<any>();
    expect(batch).toMatchObject({ status: "scheduled", total: 3, pending: 3, sent: 0, no_email: 0, source_kind: "template", reminders_on: true });
    const requests = await q("SELECT r.*, (SELECT COUNT(*) FROM items WHERE request_id = r.id) AS items FROM requests r ORDER BY title");
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.status)).toEqual(["draft", "draft", "draft"]);
    expect(requests.every((r) => r.items > 3 && r.deadline === requests[0].deadline && r.reminders_on === 1)).toBe(true);
    expect(requests[0].title).toBe(`${new Date(requests[0].deadline).getUTCFullYear()} taxes for Client 0`);
    expect(await q("SELECT 1 FROM links")).toHaveLength(0);
    expect(sent.filter((m) => m.subject.startsWith("Documents requested"))).toHaveLength(0);
    const audit = await q("SELECT action, meta FROM audit WHERE action = 'batch.create'");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].meta)).toMatchObject({ kind: "template", count: 3 });
  });

  it("copies the items of an existing request, reset", async () => {
    const { cookie, ids } = await ready(2);
    const src = await (
      await api("/api/requests", { method: "POST", cookie, body: { client_id: ids[0], title: "Source", note: "Hello", deadline: inDays(30), items: [{ label: "A", help: "h", required: true }, { label: "B", required: false }] } })
    ).json<any>();
    await env.DB_NA.prepare("UPDATE items SET status = 'rejected', reject_note = 'blurry', reviewed_at = 5, reviewed_by = 'x', unavailable_note = 'n', unavailable_at = 6 WHERE request_id = ?").bind(src.id).run();
    const res = await create(cookie, { request_id: src.id, client_ids: [ids[1]], title: "Copy", deadline: inDays(60), reminders_on: false });
    expect(res.status).toBe(201);
    const made = await q("SELECT id, note, reminders_on FROM requests WHERE title = 'Copy'");
    expect(made).toEqual([{ id: expect.any(String), note: "Hello", reminders_on: 0 }]);
    const items = await q("SELECT label, help, required, position, status, reject_note, reviewed_at, reviewed_by, unavailable_note, unavailable_at FROM items WHERE request_id = ? ORDER BY position", made[0].id);
    expect(items).toEqual([
      { label: "A", help: "h", required: 1, position: 0, status: "empty", reject_note: null, reviewed_at: null, reviewed_by: null, unavailable_note: null, unavailable_at: null },
      { label: "B", help: null, required: 0, position: 1, status: "empty", reject_note: null, reviewed_at: null, reviewed_by: null, unavailable_note: null, unavailable_at: null },
    ]);
  });

  it("lists clients without a usable email as no email from the start", async () => {
    const { cookie, ids } = await ready(4);
    await env.DB_NA.prepare("UPDATE clients SET email = NULL WHERE id = ?").bind(ids[0]).run();
    await env.DB_NA.prepare("UPDATE clients SET email_ok_at = NULL WHERE id = ?").bind(ids[1]).run();
    await env.DB_NA.prepare("UPDATE clients SET email_stop_at = 5 WHERE id = ?").bind(ids[2]).run();
    const batch = await (await create(cookie, body(ids))).json<any>();
    expect(batch).toMatchObject({ pending: 1, no_email: 3 });
    const rows = await (await api(`/api/batches/${batch.id}/rows?filter=no_email`, { cookie })).json<any>();
    expect(rows.rows).toHaveLength(3);
  });

  it("refuses a batch over the size or the daily cap before making anything", async () => {
    const { cookie, ids } = await ready(2);
    const many = Array.from({ length: 1001 }, () => randomId());
    const big = await create(cookie, body(many));
    expect([big.status, (await big.json<any>()).error]).toEqual([400, "batch_too_big"]);

    const firm = await firmRow(cookie);
    await env.DB_NA.prepare("INSERT INTO batches (id, firm_id, title, source_kind, reminders_on, send_at, total, created_by, created_at) VALUES (?, ?, 'x', 'template', 1, 1, 1999, 'u', ?)")
      .bind(randomId(), firm.id, Date.now())
      .run();
    const over = await create(cookie, body(ids));
    expect([over.status, (await over.json<any>()).error]).toEqual([429, "batch_limit"]);
    expect(await q("SELECT 1 FROM requests")).toHaveLength(0);
    expect(await q("SELECT 1 FROM batch_items")).toHaveLength(0);
    expect(await q("SELECT 1 FROM batches")).toHaveLength(1);
    // one fewer fits
    expect((await create(cookie, body([ids[0]]))).status).toBe(201);
  });

  it("does not count batch requests against the 300 a day made one by one", async () => {
    const { cookie, ids } = await ready(1);
    const firm = await firmRow(cookie);
    const big = await addClients(cookie, 300, 1);
    expect((await create(cookie, body(big))).status).toBe(201);
    const one = await api("/api/requests", { method: "POST", cookie, body: { client_id: ids[0], title: "By hand", deadline: inDays(5), items: [{ label: "A" }] } });
    expect(one.status).toBe(201);
    expect((await q("SELECT COUNT(*) AS n FROM requests WHERE firm_id = ?", firm.id))[0].n).toBe(302);
  });

  it("refuses unknown, deleted and other accounts' clients as a whole", async () => {
    const { cookie, ids } = await ready(2, "a@firm.test");
    const other = await ready(1, "b@firm.test");
    const stranger = (await q("SELECT id FROM clients WHERE name = 'Client 0' AND firm_id != (SELECT firm_id FROM clients WHERE id = ?)", ids[0])).map((r) => r.id);
    expect(stranger).toHaveLength(1);
    expect((await create(cookie, body([ids[0], stranger[0]]))).status).toBe(404);
    await api(`/api/clients/${ids[1]}`, { method: "DELETE", cookie });
    expect((await create(cookie, body(ids))).status).toBe(404);
    expect((await create(cookie, body([randomId()]))).status).toBe(404);
    expect((await create(cookie, { ...body(ids), template_id: randomId() })).status).toBe(404);
    expect(await q("SELECT 1 FROM requests")).toHaveLength(0);
    expect(other.ids).toHaveLength(1);
  });

  it("checks the plan, the profile and the input", async () => {
    const { cookie, ids } = await ready(1);
    expect((await create(cookie, { ...body(ids), title: "" })).status).toBe(400);
    expect((await create(cookie, { ...body(ids), reminders_on: "yes" })).status).toBe(400);
    expect((await create(cookie, { ...body(ids), deadline: Date.now() - 1000 })).status).toBe(400);
    expect((await create(cookie, { ...body(ids), send_at: "tomorrow" })).status).toBe(400);
    expect((await create(cookie, { ...body(ids), send_at: "2020-01-01T09:00" })).status).toBe(400);
    expect((await create(cookie, { ...body(ids), request_id: randomId() })).status).toBe(400);
    expect((await create(cookie, { ...body(ids), client_ids: [] })).status).toBe(400);
    await api("/api/firm", { method: "PATCH", cookie, body: { address: "" } });
    expect((await (await create(cookie, body(ids))).json<any>()).error).toBe("address_needed");
    await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'canceled'").run();
    expect((await create(cookie, body(ids))).status).toBe(402);
    expect(await q("SELECT 1 FROM requests")).toHaveLength(0);
  });
});

describe("sending a batch", () => {
  const invites = (sent: ReturnType<typeof mockOutbound>) => sent.filter((m) => m.subject.startsWith("Documents requested"));

  it("emails every reachable client, opens their request and lists the rest as no email", async () => {
    const { cookie, ids } = await ready(4);
    const sent = mockOutbound();
    await env.DB_NA.prepare("UPDATE clients SET email = NULL, email_ok_at = NULL WHERE id = ?").bind(ids[0]).run();
    const batch = await (await create(cookie, body(ids))).json<any>();
    await env.DB_NA.prepare("UPDATE clients SET email_stop_at = 5 WHERE id = ?").bind(ids[1]).run();
    await runBatches(env, NOW);
    expect(invites(sent).map((m) => m.to[0]).sort()).toEqual(["c2@mail.test", "c3@mail.test"]);
    expect(invites(sent)[0].text).toContain("https://collect.alazy.app/c/na_");
    const done = await one(batch.id, cookie);
    expect(done).toMatchObject({ status: "done", sent: 2, no_email: 2, pending: 0, limited_at: null });
    const reqs = await q("SELECT c.name, r.status, r.sent_at, r.next_reminder_at FROM requests r JOIN clients c ON c.id = r.client_id ORDER BY c.name");
    expect(reqs.map((r) => [r.name, r.status])).toEqual([["Client 0", "draft"], ["Client 1", "draft"], ["Client 2", "open"], ["Client 3", "open"]]);
    expect(reqs[2].sent_at).toBe(NOW);
    expect(reqs[2].next_reminder_at).toBeGreaterThan(NOW);
    expect(await q("SELECT 1 FROM links")).toHaveLength(2);
    const audit = await q("SELECT actor_type, object_type, meta FROM audit WHERE action = 'batch.send'");
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actor_type: "system", object_type: "request" });
    expect(JSON.parse(audit[0].meta).batch).toBe(batch.id);
    expect(await q("SELECT 1 FROM messages WHERE kind = 'invite' AND status = 'sent'")).toHaveLength(2);
    // nothing goes twice
    await runBatches(env, NOW + HOUR);
    expect(invites(sent)).toHaveLength(2);
  });

  it("holds an address that stopped through email_stops", async () => {
    const { cookie, ids } = await ready(2);
    const sent = mockOutbound();
    const firm = await firmRow(cookie);
    const { stopHash } = await import("../src/mail");
    await env.DB_NA.prepare("INSERT INTO email_stops (firm_id, email_hash, stopped_at) VALUES (?, ?, 1)").bind(firm.id, await stopHash(env, "c0@mail.test")).run();
    await create(cookie, body(ids));
    await runBatches(env, NOW);
    expect(invites(sent).map((m) => m.to[0])).toEqual(["c1@mail.test"]);
    expect(await q("SELECT state FROM batch_items WHERE state = 'no_email'")).toHaveLength(1);
  });

  it("waits for its date and time in the account's zone", async () => {
    const { cookie, ids } = await ready(2);
    const sent = mockOutbound();
    const batch = await (await create(cookie, body(ids, { send_at: "2027-01-13T11:30" }))).json<any>();
    expect(batch.send_at).toBe(at(2027, 1, 13, 11, 30));
    await runBatches(env, at(2027, 1, 13, 11, 29));
    expect(invites(sent)).toHaveLength(0);
    expect((await one(batch.id, cookie)).status).toBe("scheduled");
    await runBatches(env, at(2027, 1, 13, 11, 30));
    expect(invites(sent)).toHaveLength(2);
    expect((await one(batch.id, cookie)).status).toBe("done");
  });

  it("keeps to the quiet hours and goes at 9:00", async () => {
    const { cookie, ids } = await ready(2);
    const sent = mockOutbound();
    await create(cookie, body(ids));
    await runBatches(env, at(2027, 1, 12, 8, 59));
    await runBatches(env, at(2027, 1, 12, 19));
    await runBatches(env, at(2027, 1, 12, 23));
    expect(invites(sent)).toHaveLength(0);
    await runBatches(env, at(2027, 1, 13, 9));
    expect(invites(sent)).toHaveLength(2);
  });

  it("sends a bounded number each run", async () => {
    const { cookie, ids } = await ready(60);
    const sent = mockOutbound();
    // a subscription raises the daily limit from 50 to 500
    await env.CONTROL.prepare("UPDATE firms SET stripe_subscription_id = 'sub_1'").run();
    const batch = await (await create(cookie, body(ids))).json<any>();
    await runBatches(env, NOW);
    expect(invites(sent)).toHaveLength(25);
    expect(await one(batch.id, cookie)).toMatchObject({ status: "sending", sent: 25, pending: 35 });
    await runBatches(env, NOW + 10 * MINUTE);
    await runBatches(env, NOW + 20 * MINUTE);
    expect(invites(sent)).toHaveLength(60);
    expect((await one(batch.id, cookie)).status).toBe("done");
  });

  it("stops at the daily limit and carries on the next day", async () => {
    const { cookie, ids } = await ready(60, "owner@firm.test", "trialing");
    const sent = mockOutbound();
    await env.CONTROL.prepare("UPDATE firms SET trial_ends_at = ?").bind(at(2027, 2, 1, 0)).run();
    const batch = await (await create(cookie, body(ids))).json<any>();
    for (let i = 0; i < 6; i++) await runBatches(env, NOW + i * 10 * MINUTE);
    expect(invites(sent)).toHaveLength(50);
    const stalled = await one(batch.id, cookie);
    expect(stalled).toMatchObject({ status: "sending", sent: 50, pending: 10, total: 60 });
    expect(stalled.limited_at).toBeGreaterThan(0);
    // still inside the same 24 hours
    await runBatches(env, NOW + 12 * HOUR);
    expect(invites(sent)).toHaveLength(50);
    await runBatches(env, NOW + DAY + 2 * HOUR);
    expect(invites(sent)).toHaveLength(60);
    expect(await one(batch.id, cookie)).toMatchObject({ status: "done", sent: 60, pending: 0, limited_at: null });
  });

  it("skips a request that was closed, deleted or already sent by hand", async () => {
    const { cookie, ids } = await ready(4);
    const sent = mockOutbound();
    const batch = await (await create(cookie, body(ids))).json<any>();
    const reqs = await q("SELECT r.id, c.name FROM requests r JOIN clients c ON c.id = r.client_id ORDER BY c.name");
    await api(`/api/requests/${reqs[0].id}/close`, { method: "POST", cookie });
    await api(`/api/requests/${reqs[1].id}`, { method: "DELETE", cookie });
    await api(`/api/requests/${reqs[2].id}/link`, { method: "POST", cookie });
    await runBatches(env, NOW);
    expect(invites(sent).map((m) => m.to[0])).toEqual(["c3@mail.test"]);
    expect((await q("SELECT request_id, state, reason FROM batch_items ORDER BY position")).map((r) => [r.state, r.reason])).toEqual([
      ["skipped", "closed"],
      ["skipped", "closed"],
      ["skipped", "already_sent"],
      ["sent", null],
    ]);
    expect(await one(batch.id, cookie)).toMatchObject({ status: "done", sent: 1, skipped: 3 });
  });

  it("skips a request whose deadline passed before it went out", async () => {
    const { cookie, ids } = await ready(1);
    const sent = mockOutbound();
    await create(cookie, body(ids));
    await env.DB_NA.prepare("UPDATE requests SET deadline = ?").bind(NOW - DAY).run();
    await runBatches(env, NOW);
    expect(invites(sent)).toHaveLength(0);
    expect((await q("SELECT reason FROM batch_items"))[0].reason).toBe("deadline_passed");
  });

  it("does not send for an account whose plan has ended or that has no address", async () => {
    const { cookie, ids } = await ready(2);
    const sent = mockOutbound();
    const batch = await (await create(cookie, body(ids))).json<any>();
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'canceled'").run();
    await runBatches(env, NOW);
    expect(invites(sent)).toHaveLength(0);
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active', address = NULL").run();
    await runBatches(env, NOW);
    expect(invites(sent)).toHaveLength(0);
    expect((await one(batch.id, cookie)).pending).toBe(2);
    await env.CONTROL.prepare("UPDATE firms SET address = ?").bind(ADDRESS).run();
    await runBatches(env, NOW);
    expect(invites(sent)).toHaveLength(2);
  });

  it("retries a failed send a few times, then gives up on that client", async () => {
    const { cookie, ids } = await ready(1);
    mockOutbound(true, 400);
    const batch = await (await create(cookie, body(ids))).json<any>();
    for (let i = 0; i < 3; i++) await runBatches(env, NOW + i * 10 * MINUTE);
    expect(await one(batch.id, cookie)).toMatchObject({ status: "done", failed: 1, sent: 0 });
    expect((await q("SELECT reason, tries FROM batch_items"))[0]).toEqual({ reason: "send_failed", tries: 3 });
  });
});

describe("cancelling a batch", () => {
  it("stops sends that have not gone out and leaves the drafts", async () => {
    const { cookie, ids } = await ready(3);
    const sent = mockOutbound();
    const batch = await (await create(cookie, body(ids, { send_at: "2027-01-13T10:00" }))).json<any>();
    const res = await api(`/api/batches/${batch.id}/cancel`, { method: "POST", cookie });
    expect(await res.json()).toEqual({ ok: true, unsent: 3 });
    await runBatches(env, at(2027, 1, 14, 10));
    expect(sent.filter((m) => m.subject.startsWith("Documents requested"))).toHaveLength(0);
    expect(await one(batch.id, cookie)).toMatchObject({ status: "cancelled", cancelled: 3, pending: 0 });
    expect((await q("SELECT status FROM requests")).map((r) => r.status)).toEqual(["draft", "draft", "draft"]);
    expect(await q("SELECT 1 FROM audit WHERE action = 'batch.cancel'")).toHaveLength(1);
    expect((await api(`/api/batches/${batch.id}/cancel`, { method: "POST", cookie })).status).toBe(409);
  });

  it("keeps what already went out when stopped halfway", async () => {
    const { cookie, ids } = await ready(40);
    const sent = mockOutbound();
    const batch = await (await create(cookie, body(ids))).json<any>();
    await runBatches(env, NOW);
    const res = await (await api(`/api/batches/${batch.id}/cancel`, { method: "POST", cookie })).json<any>();
    expect(res.unsent).toBe(15);
    await runBatches(env, NOW + 10 * MINUTE);
    expect(sent.filter((m) => m.subject.startsWith("Documents requested"))).toHaveLength(25);
    expect(await one(batch.id, cookie)).toMatchObject({ status: "cancelled", sent: 25, cancelled: 15 });
  });

  it("is not available across accounts", async () => {
    const mine = await ready(1, "a@firm.test");
    const theirs = await ready(1, "b@firm.test");
    const batch = await (await create(mine.cookie, body(mine.ids))).json<any>();
    expect((await api(`/api/batches/${batch.id}/cancel`, { method: "POST", cookie: theirs.cookie })).status).toBe(404);
    expect((await api(`/api/batches/${batch.id}`, { cookie: theirs.cookie })).status).toBe(404);
    expect(((await (await api(`/api/batches/${batch.id}/rows`, { cookie: theirs.cookie })).json<any>()).rows)).toEqual([]);
    expect(((await (await api("/api/batches", { cookie: theirs.cookie })).json<any>()).rows)).toEqual([]);
    expect((await one(batch.id, mine.cookie)).status).toBe("scheduled");
  });
});

describe("the batch page", () => {
  it("counts opened, complete and needs review, and filters the rows", async () => {
    const { cookie, ids } = await ready(4);
    mockOutbound();
    const batch = await (await create(cookie, body(ids))).json<any>();
    await runBatches(env, NOW);
    const reqs = await q("SELECT r.id FROM requests r JOIN clients c ON c.id = r.client_id ORDER BY c.name");
    await env.DB_NA.prepare("UPDATE requests SET first_opened_at = ? WHERE id IN (?, ?)").bind(NOW, reqs[0].id, reqs[1].id).run();
    await env.DB_NA.prepare("UPDATE requests SET status = 'complete' WHERE id = ?").bind(reqs[0].id).run();
    await env.DB_NA.prepare("UPDATE items SET status = 'submitted' WHERE id = (SELECT id FROM items WHERE request_id = ? LIMIT 1)").bind(reqs[1].id).run();
    expect(await one(batch.id, cookie)).toMatchObject({ total: 4, sent: 4, opened: 2, complete: 1, review: 1 });
    const rows = async (filter: string) => (await (await api(`/api/batches/${batch.id}/rows?filter=${filter}`, { cookie })).json<any>()).rows.map((r: any) => r.client_name);
    expect(await rows("opened")).toEqual(["Client 0", "Client 1"]);
    expect(await rows("complete")).toEqual(["Client 0"]);
    expect(await rows("review")).toEqual(["Client 1"]);
    expect(await rows("all")).toHaveLength(4);
    expect((await api(`/api/batches/${batch.id}/rows?filter=nope`, { cookie })).status).toBe(400);
    const list = await (await api("/api/batches", { cookie })).json<any>();
    expect(list.rows.map((b: any) => b.id)).toEqual([batch.id]);
  });
});

describe("closing and purging", () => {
  it("cancels pending sends when the account is closed", async () => {
    const { cookie, ids } = await ready(3);
    const sent = mockOutbound();
    const batch = await (await create(cookie, body(ids))).json<any>();
    await api("/api/account/close", { method: "POST", cookie, body: { confirm: "Tuna Tax" } });
    expect(await q("SELECT status FROM batches")).toEqual([{ status: "cancelled" }]);
    expect(await q("SELECT state FROM batch_items WHERE state = 'pending'")).toHaveLength(0);
    await env.CONTROL.prepare("UPDATE firms SET closed_at = NULL, plan_status = 'active'").run();
    await runBatches(env, NOW);
    expect(sent.filter((m) => m.subject.startsWith("Documents requested"))).toHaveLength(0);
    expect(batch.total).toBe(3);
  });

  it("removes batch rows with the request and with the account", async () => {
    mockOutbound();
    const { cookie, ids } = await ready(2);
    await create(cookie, body(ids));
    const [first] = await q("SELECT id FROM requests ORDER BY title");
    await api(`/api/requests/${first.id}`, { method: "DELETE", cookie });
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1 WHERE id = ?").bind(first.id).run();
    await purgeExpired(env, Date.now());
    expect(await q("SELECT 1 FROM batch_items")).toHaveLength(1);
    expect(await q("SELECT 1 FROM batches")).toHaveLength(1);
    await api("/api/account/close", { method: "POST", cookie, body: { confirm: "Tuna Tax" } });
    await env.CONTROL.prepare("UPDATE firms SET closed_at = ?").bind(Date.now() - 31 * DAY).run();
    await purgeClosed(env);
    for (const t of ["batches", "batch_items", "requests", "clients"]) expect([t, await q(`SELECT 1 FROM ${t}`)]).toEqual([t, []]);
  });
});

describe("existing rows", () => {
  it("keeps clients and requests made before the new columns working", async () => {
    const { cookie } = await ready(0);
    const firm = await firmRow(cookie);
    await env.DB_NA.prepare("INSERT INTO clients (id, firm_id, name, email, created_by, created_at) VALUES (?, ?, 'Old Amy', 'Amy@Mail.test', 'u', 1)").bind(randomId(), firm.id).run();
    const list = await (await api("/api/clients", { cookie })).json<any[]>();
    expect(list[0]).toMatchObject({ name: "Old Amy", reference: null });
    const res = await (await api("/api/clients/import", { method: "POST", cookie, body: { rows: [{ name: "Amy", email: "amy@mail.test", reference: "R-1" }], import_id: randomId(), contact_ok: true } })).json<any>();
    expect(res.rows[0].status).toBe("update");
    expect((await q("SELECT reference, email_ok_at FROM clients"))[0].reference).toBe("R-1");
    const made = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: list[0].id, title: "T", deadline: inDays(9), items: [{ label: "A" }] } })).json<any>();
    expect(made.first_opened_at).toBeNull();
  });
});
