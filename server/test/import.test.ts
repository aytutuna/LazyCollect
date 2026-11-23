import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY, randomId } from "../src/util";
import { api, firmRow, login } from "./helpers";

type Row = Record<string, unknown>;

const run = (cookie: string, rows: Row[], extra: Record<string, unknown> = {}) =>
  api("/api/clients/import", { method: "POST", cookie, body: { rows, import_id: randomId(), contact_ok: true, ...extra } });
const preview = (cookie: string, rows: Row[]) => api("/api/clients/import", { method: "POST", cookie, body: { rows, dry_run: true } });
const clients = (firmId?: string) =>
  env.DB_NA.prepare(`SELECT * FROM clients ${firmId ? "WHERE firm_id = ?" : ""} ORDER BY name`)
    .bind(...(firmId ? [firmId] : []))
    .all<any>()
    .then((r) => r.results);

describe("client import", () => {
  it("answers 401 without a session", async () => {
    expect((await api("/api/clients/import", { method: "POST", body: {} })).status).toBe(401);
  });

  it("previews each row as new, update or skip and writes nothing", async () => {
    const cookie = await login();
    await run(cookie, [{ name: "Amy", email: "amy@mail.test" }, { name: "Bo", email: "bo@mail.test", phone: "613-555-0101", reference: "F-1" }]);
    const res = await preview(cookie, [
      { name: "Cy", email: "cy@mail.test" },
      { name: "Amy again", email: "AMY@mail.test", phone: "416-555-0100" },
      { name: "Bo", email: "bo@mail.test", phone: "613-555-0101", reference: "F-1" },
      { name: "", email: "x@mail.test" },
      { name: "Di", email: "nope" },
      { name: "Ed", email: "ed@mail.test", phone: "abc" },
      { name: "Fay", email: "cy@mail.test" },
    ]);
    const body = await res.json<any>();
    expect(body.rows.map((r: any) => [r.status, r.reason])).toEqual([
      ["new", undefined],
      ["update", undefined],
      ["skip", "nothing_new"],
      ["skip", "no_name"],
      ["skip", "bad_email"],
      ["skip", "bad_phone"],
      ["skip", "duplicate_in_file"],
    ]);
    expect(body.counts).toEqual({ new: 1, update: 1, skip: 5 });
    expect(await clients()).toHaveLength(2);
  });

  it("creates clients with consent per client and one audit row across chunks", async () => {
    const cookie = await login();
    const me = await (await api("/api/me", { cookie })).json<any>();
    const importId = randomId();
    const a = await run(cookie, [{ name: "Amy", email: "amy@mail.test", phone: "613-555-0101", reference: "A-1" }, { name: "Bo" }], { import_id: importId });
    expect(a.status).toBe(200);
    await run(cookie, [{ name: "Cy", email: "cy@mail.test" }, { name: "", email: "x@mail.test" }], { import_id: importId });
    const rows = await clients();
    expect(rows.map((r) => r.name)).toEqual(["Amy", "Bo", "Cy"]);
    expect(rows[0]).toMatchObject({ email: "amy@mail.test", reference: "A-1", consent_by: me.user.id });
    expect(rows[0].email_ok_at).toBeGreaterThan(0);
    expect(rows[0].sms_ok_at).toBeGreaterThan(0);
    expect(rows[1]).toMatchObject({ email: null, email_ok_at: null, sms_ok_at: null, consent_by: null });
    expect(rows[2].sms_ok_at).toBeNull();
    const audit = (await env.DB_NA.prepare("SELECT * FROM audit WHERE action = 'client.import'").all<any>()).results;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ id: importId, actor_id: me.user.id, object_type: "import" });
    expect(JSON.parse(audit[0].meta)).toEqual({ new: 3, update: 0, skip: 1 });
  });

  it("requires the attestation and an import id", async () => {
    const cookie = await login();
    const body = { rows: [{ name: "A" }] };
    expect((await api("/api/clients/import", { method: "POST", cookie, body: { ...body, import_id: randomId() } })).status).toBe(400);
    expect((await api("/api/clients/import", { method: "POST", cookie, body: { ...body, contact_ok: false, import_id: randomId() } })).status).toBe(400);
    expect((await api("/api/clients/import", { method: "POST", cookie, body: { ...body, contact_ok: true } })).status).toBe(400);
    expect((await api("/api/clients/import", { method: "POST", cookie, body: { rows: [], dry_run: true } })).status).toBe(400);
    expect((await api("/api/clients/import", { method: "POST", cookie, body: { rows: Array(201).fill({ name: "A" }), dry_run: true } })).status).toBe(400);
    expect(await clients()).toHaveLength(0);
  });

  it("fills empty fields of an existing client and never overwrites", async () => {
    const cookie = await login();
    const first = await (await api("/api/clients", { method: "POST", cookie, body: { name: "Amy Lee", email: "amy@mail.test", reference: "OLD", contact_ok: false } })).json<any>();
    const res = await (await run(cookie, [{ name: "Amelia", email: "Amy@Mail.test", phone: "613-555-0101", reference: "NEW" }])).json<any>();
    expect(res.rows[0]).toMatchObject({ status: "update", id: first.id });
    const [row] = await clients();
    expect(row).toMatchObject({ id: first.id, name: "Amy Lee", reference: "OLD", phone: "613-555-0101" });
    // the bulk attestation covers the address and number that were never attested
    expect(row.email_ok_at).toBeGreaterThan(0);
    expect(row.sms_ok_at).toBeGreaterThan(0);
    expect(row.consent_by).not.toBeNull();
    const again = await (await run(cookie, [{ name: "Amy", email: "amy@mail.test", phone: "999-555-0101", reference: "X" }])).json<any>();
    expect(again.rows[0]).toMatchObject({ status: "skip", reason: "nothing_new" });
    expect((await clients())[0]).toMatchObject({ phone: "613-555-0101", reference: "OLD" });
  });

  it("keeps an existing consent time and a stop", async () => {
    const cookie = await login();
    const first = await (await api("/api/clients", { method: "POST", cookie, body: { name: "Amy", email: "amy@mail.test", contact_ok: true } })).json<any>();
    await env.DB_NA.prepare("UPDATE clients SET email_stop_at = 5 WHERE id = ?").bind(first.id).run();
    await run(cookie, [{ name: "Amy", email: "amy@mail.test", phone: "613-555-0101" }]);
    const [row] = await clients();
    expect(row.email_ok_at).toBe(first.email_ok_at);
    expect(row.email_stop_at).toBe(5);
  });

  it("matches clients without an address by name unless the references differ", async () => {
    const cookie = await login();
    await run(cookie, [{ name: "Sam Roy", reference: "A" }]);
    const res = await (await run(cookie, [{ name: "sam roy", reference: "B" }, { name: "SAM ROY", phone: "613-555-0101" }, { name: "Sam Roy", reference: "A" }])).json<any>();
    expect(res.rows.map((r: any) => r.status)).toEqual(["new", "update", "skip"]);
  });

  it("does not touch deleted clients or another account's clients", async () => {
    const mine = await login("a@firm.test");
    const theirs = await login("b@firm.test");
    await run(theirs, [{ name: "Amy", email: "amy@mail.test" }]);
    const res = await (await run(mine, [{ name: "Amy", email: "amy@mail.test", phone: "613-555-0101" }])).json<any>();
    expect(res.rows[0].status).toBe("new");
    const firmA = await firmRow(mine);
    const firmB = await firmRow(theirs);
    expect(await clients(firmA.id)).toHaveLength(1);
    const other = await clients(firmB.id);
    expect(other).toHaveLength(1);
    expect(other[0].phone).toBeNull();
    await api(`/api/clients/${(await clients(firmA.id))[0].id}`, { method: "DELETE", cookie: mine });
    const again = await (await run(mine, [{ name: "Amy", email: "amy@mail.test" }])).json<any>();
    expect(again.rows[0].status).toBe("new");
  });

  it("stops at the client limit", async () => {
    const cookie = await login();
    const firm = await firmRow(cookie);
    await env.DB_NA.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 9998)
       INSERT INTO clients (id, firm_id, name, created_by, created_at) SELECT lower(hex(randomblob(16))), ?, 'Filler ' || i, 'x', 1 FROM n`,
    )
      .bind(firm.id)
      .run();
    const res = await (await run(cookie, [{ name: "A" }, { name: "B" }, { name: "C" }])).json<any>();
    expect(res.rows.map((r: any) => [r.status, r.reason])).toEqual([["new", undefined], ["new", undefined], ["skip", "client_limit"]]);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM clients").first<any>()).n).toBe(10000);
  });

  it("is blocked when the plan is not usable", async () => {
    const cookie = await login();
    await env.CONTROL.prepare("UPDATE firms SET trial_ends_at = ?").bind(Date.now() - DAY).run();
    expect((await run(cookie, [{ name: "A" }])).status).toBe(402);
    expect((await preview(cookie, [{ name: "A" }])).status).toBe(402);
    expect(await clients()).toHaveLength(0);
  });

  it("finds a client by reference in the search", async () => {
    const cookie = await login();
    await run(cookie, [{ name: "Amy", reference: "FILE-77" }]);
    const found = await (await api("/api/clients/search?q=FILE-77", { cookie })).json<any>();
    expect(found.rows.map((r: any) => r.name)).toEqual(["Amy"]);
  });
});

describe("matching names without an email", () => {
  it("ignores case on accented letters too", async () => {
    const cookie = await login();
    await run(cookie, [{ name: "Élodie Côté" }]);
    const again = await (await run(cookie, [{ name: "ÉLODIE CÔTÉ" }, { name: "élodie côté" }])).json<any>();
    expect(again.rows.map((r: any) => [r.status, r.reason])).toEqual([["skip", "nothing_new"], ["skip", "duplicate_in_file"]]);
    expect(await clients()).toHaveLength(1);
  });
});
