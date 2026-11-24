import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeExpired } from "../src/purge";
import { RESTORE_WINDOW, randomId } from "../src/util";
import { FAMILY, ITEMS, born, family, year } from "./family";
import { api, inDays, pdf, setup, upload } from "./helpers";

const labels = (req: any) => req.items.map((i: any) => i.label);
const q = <T = any>(sql: string, ...binds: unknown[]) => env.DB_NA.prepare(sql).bind(...binds).all<T>().then((r) => r.results);
const openLink = async (cookie: string, id: string) => `/api/c/${(await (await api(`/api/requests/${id}/link`, { method: "POST", cookie })).json<any>()).url.split("/c/")[1]}`;

describe("people on a new request", () => {
  it("expands each per-person item for the people it is for, labelled with their names", async () => {
    const { req, res } = await family();
    expect(res.status).toBe(201);
    expect(req.people.map((p: any) => [p.position, p.role, p.name, p.dob])).toEqual(FAMILY.map((p, i) => [i, p.role, p.name, p.dob ?? null]));
    expect(labels(req)).toEqual([
      "Marriage certificate",
      "Passport — Omar Haddad",
      "Passport — Amira Haddad",
      "Passport — Layla Haddad",
      "Passport — Yusuf Haddad",
      "Passport — Sami Haddad",
      "Police certificate — Omar Haddad",
      "Police certificate — Amira Haddad",
      "Police certificate — Yusuf Haddad",
      "Spouse's employment letter — Amira Haddad",
      "School letter — Layla Haddad",
      "School letter — Yusuf Haddad",
      "School letter — Sami Haddad",
      "Job offer — Omar Haddad",
    ]);
    expect(req.items.map((i: any) => i.position)).toEqual(req.items.map((_: any, at: number) => at));
    expect(req.items[0].person_pos).toBeNull();
    expect(req.items[1]).toMatchObject({ person_pos: 0, expiry_rule: "expiry", required: true });
    expect(req.per_person_items).toBe(5);
  });

  it("takes adults by date of birth when there is one and by role when there is not", async () => {
    const { req } = await family();
    const police = labels(req).filter((l: string) => l.startsWith("Police"));
    // a 20-year-old dependant counts as an adult, a 10-year-old does not, and a child without a date is not one
    expect(police).toEqual(["Police certificate — Omar Haddad", "Police certificate — Amira Haddad", "Police certificate — Yusuf Haddad"]);
    const noDates = await family({ people: [{ role: "other", name: "Aunt" }, { role: "child", name: "Kid" }] }, "b@firm.test");
    expect(labels(noDates.req).filter((l: string) => l.startsWith("Police"))).toEqual(["Police certificate — Aunt"]);
    const nobody = await family({ people: [] }, "c@firm.test");
    expect(labels(nobody.req)).toEqual(["Marriage certificate"]);
    expect(nobody.req.per_person_items).toBe(5);
  });

  it("works out an age on the birthday", async () => {
    // the firm's day, not UTC's: they differ for hours every evening
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
    const thisYear = Number(today.slice(0, 4));
    const day = (y: number) => `${y}${today.slice(4)}`;
    const items = [{ label: "Passport", per_person: "adults", required: true }];
    const { req } = await family({ items, people: [{ role: "child", name: "Turned", dob: day(thisYear - 18) }, { role: "child", name: "Not yet", dob: day(thisYear - 18 + 1) }] });
    expect(labels(req)).toEqual(["Passport — Turned"]);
  });

  it("moves conditions to where their items landed", async () => {
    const items = [
      { label: "Moved?", kind: "yesno", required: true },
      { label: "Passport", per_person: "everyone", required: true },
      { label: "Moving receipts", required: true, show_if: { item: 0, value: "yes" } },
    ];
    const { req } = await family({ items, people: FAMILY.slice(0, 2) });
    expect(labels(req)).toEqual(["Moved?", "Passport — Omar Haddad", "Passport — Amira Haddad", "Moving receipts"]);
    expect(req.items[3]).toMatchObject({ show_if_pos: 0, show_if_value: "yes" });
  });

  it("refuses what cannot be valid", async () => {
    const { cookie, client } = await setup();
    const make = (body: Record<string, unknown>) => api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "A", deadline: inDays(7), items: ITEMS, people: FAMILY, ...body } });
    expect((await make({ people: [{ role: "cousin", name: "X" }] })).status).toBe(400);
    expect((await make({ people: [{ role: "child", name: " " }] })).status).toBe(400);
    expect((await make({ people: [{ role: "child", name: "X", dob: "2020-02-30" }] })).status).toBe(400);
    expect((await make({ people: Array.from({ length: 13 }, (_, i) => ({ role: "other", name: `P${i}` })) })).status).toBe(400);
    expect((await make({ people: "me" })).status).toBe(400);
    for (const bad of [
      { label: "x", per_person: "all" },
      { label: "x", per_person: "adults", kind: "yesno" },
      { label: "x", kind: "text", per_person: "adults", show_if: { item: 0, value: "yes" } },
      { label: "x", expiry: "issue" },
      { label: "x", expiry: "issue", valid_months: 0 },
      { label: "x", expiry: "expiry", valid_months: 6 },
      { label: "x", kind: "text", expiry: "expiry" },
      { label: "x", kind: "text", translation: true },
    ]) {
      expect([bad, (await make({ items: [{ label: "Moved?", kind: "yesno" }, bad] })).status]).toEqual([bad, 400]);
    }
    // an item for each person cannot be what another item waits on
    expect((await make({ items: [{ label: "Who", per_person: "everyone", kind: "text" }, { label: "y", show_if: { item: 0, value: "yes" } }] })).status).toBe(400);
  });

  it("refuses a request that would hold too many items", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ label: `Doc ${i}`, per_person: "everyone", required: true }));
    const { res, req } = await family({ items, people: Array.from({ length: 11 }, (_, i) => ({ role: "other", name: `P${i}` })) });
    expect([res.status, req]).toEqual([409, { error: "too_many_items" }]);
  });
});

describe("adding, renaming and removing people", () => {
  it("expands the waiting items for a person added later, after the items already there", async () => {
    const { cookie, req } = await family({ people: FAMILY.slice(0, 1) });
    const before = req.items.length;
    const res = await api(`/api/requests/${req.id}/people`, { method: "POST", cookie, body: { role: "spouse", name: "Amira Haddad" } });
    expect(res.status).toBe(201);
    const next = await res.json<any>();
    expect(next.people.map((p: any) => [p.position, p.name])).toEqual([[0, "Omar Haddad"], [1, "Amira Haddad"]]);
    expect(labels(next).slice(before)).toEqual(["Passport — Amira Haddad", "Police certificate — Amira Haddad", "Spouse's employment letter — Amira Haddad"]);
    expect(next.items.slice(before).map((i: any) => [i.position, i.person_pos])).toEqual([[before, 1], [before + 1, 1], [before + 2, 1]]);
    const audit = await q("SELECT meta FROM audit WHERE action = 'person.add'");
    expect(audit).toHaveLength(1);
    expect(audit[0].meta).not.toContain("Amira");
  });

  it("reopens a complete request that gets a new person", async () => {
    const { cookie, client } = await setup();
    const items = [{ label: "Passport", per_person: "everyone", required: true }];
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "A", deadline: inDays(7), items, people: [FAMILY[0]] } })).json<any>();
    const path = await openLink(cookie, req.id);
    expect((await upload(path, req.items[0].id, pdf(100))).status).toBe(201);
    expect((await q("SELECT status FROM requests"))[0].status).toBe("complete");
    await api(`/api/requests/${req.id}/people`, { method: "POST", cookie, body: FAMILY[1] });
    expect((await q("SELECT status FROM requests"))[0].status).toBe("open");
  });

  it("refuses bad people, a thirteenth person and a closed request", async () => {
    const { cookie, req } = await family({ people: [] });
    const add = (body: unknown) => api(`/api/requests/${req.id}/people`, { method: "POST", cookie, body });
    expect((await add({ role: "x", name: "A" })).status).toBe(400);
    expect((await add({ role: "child" })).status).toBe(400);
    for (let i = 0; i < 12; i++) expect((await add({ role: "other", name: `P${i}` })).status).toBe(201);
    const full = await add({ role: "other", name: "One more" });
    expect([full.status, await full.json()]).toEqual([409, { error: "too_many_people" }]);
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    expect((await add({ role: "other", name: "Late" })).status).toBe(409);
  });

  it("renames a person in every label made from their name, with their companions", async () => {
    const items = [{ label: "Passport", per_person: "everyone", required: true, translation: true }];
    const { cookie, req } = await family({ items, people: FAMILY.slice(0, 2) });
    const amira = req.people[1];
    const res = await api(`/api/requests/${req.id}/people/${amira.id}`, { method: "PATCH", cookie, body: { name: "Amira Khalil" } });
    expect(res.status).toBe(200);
    const next = await res.json<any>();
    expect(labels(next).filter((l: string) => l.includes("Khalil"))).toEqual([
      "Passport — Amira Khalil",
      "Is Passport — Amira Khalil in English or French?",
      "Certified translation of Passport — Amira Khalil",
    ]);
    expect(next.people[1].name).toBe("Amira Khalil");
    expect(labels(next).some((l: string) => l.includes("Haddad") && !l.includes("Omar"))).toBe(false);
    expect((await api(`/api/requests/${req.id}/people/${amira.id}`, { method: "PATCH", cookie, body: { name: "" } })).status).toBe(400);
    expect((await api(`/api/requests/${req.id}/people/${amira.id}`, { method: "PATCH", cookie, body: {} })).status).toBe(400);
    expect((await api(`/api/requests/${req.id}/people/${randomId()}`, { method: "PATCH", cookie, body: { name: "x" } })).status).toBe(404);
  });

  it("keeps a person's name when a document of theirs is renamed", async () => {
    const { cookie, req } = await family({ people: FAMILY.slice(0, 1) });
    const passport = req.items.find((i: any) => i.label === "Passport — Omar Haddad");
    const res = await api(`/api/requests/${req.id}/items/${passport.id}`, { method: "PATCH", cookie, body: { label: "Passport pages" } });
    expect((await res.json<any>()).label).toBe("Passport pages — Omar Haddad");
    const rename = await api(`/api/requests/${req.id}/people/${req.people[0].id}`, { method: "PATCH", cookie, body: { name: "Omar H" } });
    expect(labels(await rename.json<any>())).toContain("Passport pages — Omar H");
  });

  it("removes a person with their items, and keeps what is waiting for the next person", async () => {
    const { cookie, req } = await family({ people: FAMILY.slice(0, 2) });
    const omar = req.people[0];
    const res = await api(`/api/requests/${req.id}/people/${omar.id}`, { method: "DELETE", cookie });
    expect(res.status).toBe(200);
    const next = await res.json<any>();
    expect(next.people.map((p: any) => p.name)).toEqual(["Amira Haddad"]);
    expect(labels(next).some((l: string) => l.includes("Omar"))).toBe(false);
    expect(next.items.filter((i: any) => i.person_pos === 0)).toHaveLength(0);
    expect(next.items.filter((i: any) => i.person_pos === 1).length).toBeGreaterThan(0);
    expect((await q("SELECT COUNT(*) AS n FROM people"))[0].n).toBe(1);
    // the position of a person who is gone is not given again
    const again = await (await api(`/api/requests/${req.id}/people`, { method: "POST", cookie, body: { role: "principal", name: "Omar Haddad" } })).json<any>();
    expect(again.people.map((p: any) => p.position)).toEqual([1, 2]);
    expect((await q("SELECT meta FROM audit WHERE action = 'person.remove'"))[0].meta).not.toContain("Omar");
  });

  it("refuses to remove a person whose items hold files until it is confirmed", async () => {
    const { cookie, req } = await family({ people: FAMILY.slice(0, 2) });
    const path = await openLink(cookie, req.id);
    const passport = req.items.find((i: any) => i.label === "Passport — Amira Haddad");
    expect((await upload(path, passport.id, pdf(300))).status).toBe(201);
    expect((await env.FILES_NA.list()).objects).toHaveLength(1);
    const amira = req.people[1];
    const refused = await api(`/api/requests/${req.id}/people/${amira.id}`, { method: "DELETE", cookie });
    expect([refused.status, await refused.json()]).toEqual([409, { error: "has_data", items: 1 }]);
    expect((await q("SELECT COUNT(*) AS n FROM files"))[0].n).toBe(1);
    const done = await api(`/api/requests/${req.id}/people/${amira.id}?confirm=1`, { method: "DELETE", cookie });
    expect(done.status).toBe(200);
    expect((await q("SELECT COUNT(*) AS n FROM files"))[0].n).toBe(0);
    expect((await env.FILES_NA.list()).objects).toHaveLength(0);
    expect((await q("SELECT COUNT(*) AS n FROM items WHERE person_pos = 1"))[0].n).toBe(0);
  });

  it("does not remove anyone from a request on legal hold", async () => {
    const { cookie, req } = await family({ people: FAMILY.slice(0, 1) });
    await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: true } });
    const res = await api(`/api/requests/${req.id}/people/${req.people[0].id}?confirm=1`, { method: "DELETE", cookie });
    expect([res.status, await res.json()]).toEqual([409, { error: "legal_hold" }]);
    expect((await q("SELECT COUNT(*) AS n FROM people"))[0].n).toBe(1);
  });

  it("adds an item for each person to a request that already exists", async () => {
    const { cookie, req } = await family({ items: [{ label: "Marriage certificate" }], people: FAMILY.slice(0, 2) });
    expect(req.items).toHaveLength(1);
    const res = await api(`/api/requests/${req.id}/items`, { method: "POST", cookie, body: { label: "Passport", per_person: "everyone", required: true } });
    expect(res.status).toBe(201);
    const next = await res.json<any>();
    expect(labels(next)).toEqual(["Marriage certificate", "Passport — Omar Haddad", "Passport — Amira Haddad"]);
    expect(next.per_person_items).toBe(1);
    const third = await (await api(`/api/requests/${req.id}/people`, { method: "POST", cookie, body: { role: "child", name: "Layla" } })).json<any>();
    expect(labels(third).at(-1)).toBe("Passport — Layla");
  });

  it("answers 404 to another account on every people route", async () => {
    const { req } = await family();
    const other = await setup("b@two.test", "Two Inc");
    const person = req.people[0];
    for (const [method, path, body] of [
      ["POST", `/api/requests/${req.id}/people`, { role: "other", name: "X" }],
      ["PATCH", `/api/requests/${req.id}/people/${person.id}`, { name: "X" }],
      ["DELETE", `/api/requests/${req.id}/people/${person.id}?confirm=1`],
    ] as const) {
      expect([method, (await api(path, { method, cookie: other.cookie, body })).status]).toEqual([method, 404]);
    }
    expect((await q("SELECT COUNT(*) AS n FROM people"))[0].n).toBe(FAMILY.length);
    expect((await q("SELECT COUNT(*) AS n FROM items WHERE person_pos IS NOT NULL"))[0].n).toBeGreaterThan(0);
  });
});

describe("changes to an item for each person", () => {
  const blueprints = async (id: string) => JSON.parse((await q("SELECT per_person_json FROM requests WHERE id = ?", id))[0].per_person_json ?? "[]");

  it("reach the people added afterwards", async () => {
    const items = [{ label: "Passport", help: "All pages", per_person: "everyone", required: true }];
    const { cookie, req } = await family({ items, people: FAMILY.slice(0, 1) });
    expect((await blueprints(req.id))[0].key).toMatch(/^[0-9a-f]{32}$/);
    await api(`/api/requests/${req.id}/items/${req.items[0].id}`, { method: "PATCH", cookie, body: { label: "Passport pages", help: "", required: false } });
    const next = await (await api(`/api/requests/${req.id}/people`, { method: "POST", cookie, body: FAMILY[1] })).json<any>();
    expect(next.items[1]).toMatchObject({ label: "Passport pages — Amira Haddad", help: null, required: false });
    expect(await blueprints(req.id)).toMatchObject([{ label: "Passport pages", required: false }]);
  });

  it("are not made by a label sent back as it was", async () => {
    const { cookie, req } = await family({ people: FAMILY.slice(0, 1) });
    const passport = req.items.find((i: any) => i.label === "Passport — Omar Haddad");
    const res = await api(`/api/requests/${req.id}/items/${passport.id}`, { method: "PATCH", cookie, body: { label: "Passport", required: false } });
    expect(await res.json()).toMatchObject({ label: "Passport — Omar Haddad", required: false });
  });

  it("drop the entry for later people once the last item made from it is deleted", async () => {
    const items = [{ label: "Passport", per_person: "everyone", required: true }, { label: "Photo", per_person: "everyone", required: true }];
    const { cookie, req } = await family({ items, people: FAMILY.slice(0, 2) });
    const passports = req.items.filter((i: any) => i.label.startsWith("Passport"));
    await api(`/api/requests/${req.id}/items/${passports[0].id}`, { method: "DELETE", cookie });
    expect(await blueprints(req.id)).toHaveLength(2);
    await api(`/api/requests/${req.id}/items/${passports[1].id}`, { method: "DELETE", cookie });
    expect((await blueprints(req.id)).map((b: any) => b.label)).toEqual(["Photo"]);
    const next = await (await api(`/api/requests/${req.id}/people`, { method: "POST", cookie, body: FAMILY[2] })).json<any>();
    expect(labels(next).slice(-1)).toEqual(["Photo — Layla Haddad"]);
  });
});

describe("the client page", () => {
  it("lists the people by name and role and not their birth dates", async () => {
    const { cookie, req } = await family();
    const page = await (await api(await openLink(cookie, req.id))).json<any>();
    expect(page.people).toEqual(FAMILY.map((p, i) => ({ position: i, role: p.role, name: p.name })));
    expect(page.items[1]).toMatchObject({ label: "Passport — Omar Haddad", person_pos: 0, expiry_rule: "expiry", expires_on: null });
    expect(JSON.stringify(page)).not.toContain(born(40));
  });
});

describe("repeats", () => {
  it("copies the people, links their items to the copies and starts the dates over", async () => {
    const { cookie, req } = await family({ people: FAMILY.slice(0, 2) });
    const passport = req.items.find((i: any) => i.label === "Passport — Amira Haddad");
    await api(`/api/requests/${req.id}/items/${passport.id}`, { method: "PATCH", cookie, body: { expires_on: "2031-05-01" } });
    await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { valid_until: "2027-12-31" } });
    const res = await api(`/api/requests/${req.id}/repeat`, { method: "POST", cookie });
    expect(res.status).toBe(201);
    const made = await res.json<any>();
    expect(made.people.map((p: any) => [p.position, p.role, p.name, p.dob])).toEqual([[0, "principal", "Omar Haddad", born(40)], [1, "spouse", "Amira Haddad", null]]);
    expect(made.people[0].id).not.toBe(req.people[0].id);
    expect(labels(made)).toEqual(labels(req));
    expect(made.items.map((i: any) => i.person_pos)).toEqual(req.items.map((i: any) => i.person_pos));
    expect(made.items.every((i: any) => i.expires_on === null && i.status === "empty")).toBe(true);
    expect([made.valid_until, made.valid_until_set, made.per_person_items]).toEqual(["2028-12-31", true, 5]);
    // the copy takes a new person like the first request does
    const third = await (await api(`/api/requests/${made.id}/people`, { method: "POST", cookie, body: { role: "child", name: "Layla", dob: born(5) } })).json<any>();
    expect(labels(third).at(-1)).toBe("School letter — Layla");
  });
});

describe("batches", () => {
  const batch = async (cookie: string, body: Record<string, unknown>) => {
    await api("/api/firm", { method: "PATCH", cookie, body: { address: "12 King St W, Toronto ON M5H 1A1" } });
    return api("/api/batches", { method: "POST", cookie, body: { title: "Batch", reminders_on: false, ...body } });
  };
  const other = async (cookie: string) => (await (await api("/api/clients", { method: "POST", cookie, body: { name: "Bea", email: "bea@mail.test", contact_ok: true } })).json<any>()).id;

  it("repeats a family with its people and starts the documents over", async () => {
    const { cookie, req } = await family({ people: FAMILY.slice(0, 2) });
    await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { valid_until: "2027-12-31" } });
    const res = await batch(cookie, { request_ids: [req.id] });
    expect(res.status).toBe(201);
    const [copy] = await q("SELECT id, per_person_json, valid_until FROM requests WHERE id != ?", req.id);
    expect(copy.valid_until).toBe("2028-12-31");
    expect(JSON.parse(copy.per_person_json)).toHaveLength(5);
    expect((await q("SELECT position, role, name, dob FROM people WHERE request_id = ? ORDER BY position", copy.id)).map((p) => [p.position, p.name])).toEqual([[0, "Omar Haddad"], [1, "Amira Haddad"]]);
    const mine = await q("SELECT label, person_pos FROM items WHERE request_id = ? ORDER BY position", copy.id);
    expect(mine).toEqual((await q("SELECT label, person_pos FROM items WHERE request_id = ? ORDER BY position", req.id)));
  });

  it("copying a checklist for other clients keeps what is asked of everyone and the items waiting for people", async () => {
    const { cookie, req } = await family({ people: FAMILY.slice(0, 2) });
    const bea = await other(cookie);
    expect((await batch(cookie, { request_id: req.id, client_ids: [bea], deadline: inDays(60) })).status).toBe(201);
    const [copy] = await q("SELECT id, per_person_json, valid_until FROM requests WHERE client_id = ?", bea);
    expect((await q("SELECT label FROM items WHERE request_id = ?", copy.id)).map((i) => i.label)).toEqual(["Marriage certificate"]);
    expect((await q("SELECT COUNT(*) AS n FROM people WHERE request_id = ?", copy.id))[0].n).toBe(0);
    expect(copy.valid_until).toBeNull();
    expect(JSON.parse(copy.per_person_json)).toHaveLength(5);
    // the new request's own person gets the waiting items after the common one
    const person = await (await api(`/api/requests/${copy.id}/people`, { method: "POST", cookie, body: FAMILY[0] })).json<any>();
    expect(labels(person)).toEqual(["Marriage certificate", "Passport — Omar Haddad", "Police certificate — Omar Haddad", "Job offer — Omar Haddad"]);
  });

  it("makes requests from a template with items for each person and no people", async () => {
    const { cookie } = await family({ people: [] });
    const template = await (await api("/api/templates", { method: "POST", cookie, body: { name: "Family", items: ITEMS } })).json<any>();
    const bea = await other(cookie);
    expect((await batch(cookie, { template_id: template.id, client_ids: [bea], deadline: inDays(60) })).status).toBe(201);
    const [copy] = await q("SELECT id, per_person_json FROM requests WHERE client_id = ?", bea);
    expect((await q("SELECT label FROM items WHERE request_id = ?", copy.id)).map((i) => i.label)).toEqual(["Marriage certificate"]);
    expect(JSON.parse(copy.per_person_json).map((i: any) => i.label)).toEqual(["Passport", "Police certificate", "Spouse's employment letter", "School letter", "Job offer"]);
  });
});

describe("migration 0021 on existing rows", () => {
  it("leaves requests, items and files as they were and adds the new columns empty", async () => {
    const { cookie, client } = await setup();
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "Old", deadline: inDays(7), items: [{ label: "Passport" }, { label: "Visa", required: false }] } })).json<any>();
    const path = await openLink(cookie, req.id);
    await upload(path, req.items[0].id, pdf(100));
    await env.DB_NA.batch([
      env.DB_NA.prepare("DROP INDEX idx_items_person"),
      env.DB_NA.prepare("DROP INDEX idx_items_expiry"),
      ...["person_pos", "label_base", "for_pos", "companion", "translation", "expiry_rule", "valid_months", "expires_on", "issued_on"].map((c) => env.DB_NA.prepare(`ALTER TABLE items DROP COLUMN ${c}`)),
      env.DB_NA.prepare("ALTER TABLE requests DROP COLUMN per_person_json"),
      env.DB_NA.prepare("ALTER TABLE requests DROP COLUMN valid_until"),
      env.DB_NA.prepare("DROP TABLE people"),
    ]);
    const cols = "id, position, label, help, required, status";
    const before = {
      items: (await env.DB_NA.prepare(`SELECT ${cols} FROM items ORDER BY position`).all()).results,
      requests: (await env.DB_NA.prepare("SELECT id, title, deadline, status FROM requests").all()).results,
      files: (await env.DB_NA.prepare("SELECT id, item_id, name, size FROM files").all()).results,
    };
    const migration = (env.TEST_MIGRATIONS_NA as { name: string; queries: string[] }[]).find((m) => m.name.startsWith("0021"))!;
    await env.DB_NA.batch(migration.queries.map((query) => env.DB_NA.prepare(query)));

    expect((await env.DB_NA.prepare(`SELECT ${cols} FROM items ORDER BY position`).all()).results).toEqual(before.items);
    expect((await env.DB_NA.prepare("SELECT id, title, deadline, status FROM requests").all()).results).toEqual(before.requests);
    expect((await env.DB_NA.prepare("SELECT id, item_id, name, size FROM files").all()).results).toEqual(before.files);
    expect(await env.DB_NA.prepare("SELECT person_pos, label_base, for_pos, companion, translation, expiry_rule, valid_months, expires_on, issued_on FROM items WHERE id = ?").bind(req.items[0].id).first()).toEqual({
      person_pos: null, label_base: null, for_pos: null, companion: null, translation: 0, expiry_rule: null, valid_months: null, expires_on: null, issued_on: null,
    });
    expect(await env.DB_NA.prepare("SELECT per_person_json, valid_until FROM requests").first()).toEqual({ per_person_json: null, valid_until: null });
    expect((await env.DB_NA.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

    // an old request reads as one without people or dates, and takes a person
    const view = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    expect(view).toMatchObject({ people: [], per_person_items: 0, valid_until_set: false });
    expect(view.items.map((i: any) => [i.label, i.person_pos, i.expiry_flag])).toEqual([["Passport", null, null], ["Visa", null, null]]);
    expect((await api(`/api/requests/${req.id}/people`, { method: "POST", cookie, body: FAMILY[0] })).status).toBe(201);
  });
});

describe("purging a request with people", () => {
  it("removes the people with the request", async () => {
    const { cookie, req } = await family();
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    const deletedAt = (await q("SELECT deleted_at FROM requests"))[0].deleted_at;
    await purgeExpired(env, deletedAt + RESTORE_WINDOW);
    expect((await q("SELECT COUNT(*) AS n FROM people"))[0].n).toBe(0);
    expect((await q("SELECT COUNT(*) AS n FROM items"))[0].n).toBe(0);
    expect((await q("SELECT COUNT(*) AS n FROM requests"))[0].n).toBe(0);
  });

  it("does not touch another account's people", async () => {
    const a = await family();
    const b = await family({}, "b@two.test");
    await api(`/api/requests/${a.req.id}`, { method: "DELETE", cookie: a.cookie });
    const deletedAt = (await q("SELECT deleted_at FROM requests WHERE id = ?", a.req.id))[0].deleted_at;
    await purgeExpired(env, deletedAt + RESTORE_WINDOW);
    expect((await q("SELECT COUNT(*) AS n FROM people WHERE request_id = ?", b.req.id))[0].n).toBe(FAMILY.length);
  });
});
