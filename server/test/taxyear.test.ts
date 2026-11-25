import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { UnknownYear, resolveItems, restate, suggestedYear, tax, taxYears } from "../src/taxyear";
import { builtinTemplates, factsOf } from "../src/templates";
import { randomId } from "../src/util";
import { api, firmRow, inDays, login, setup } from "./helpers";

// the generic range is built from the clock, so these checklists are asked for the last calendar year
const Y = new Date().getUTCFullYear() - 1;
const facts = { 2026: { rrsp_window: "A to B 2026" }, 2027: { rrsp_window: "C to D 2027" } };
const item = (label: string, help?: string) => ({ label, help, required: true });
const builtin = (id: string) => builtinTemplates.find((t) => t.id === id)!;
const labels = (r: { items: { label: string; help?: string | null }[] }) => r.items.map((i) => i.label);
const make = (cookie: string, clientId: string, extra: Record<string, unknown>) =>
  api("/api/requests", { method: "POST", cookie, body: { client_id: clientId, title: "Taxes", deadline: inDays(30), ...extra } });
const repeat = (cookie: string, id: string) => api(`/api/requests/${id}/repeat`, { method: "POST", cookie });
const q = <T = any>(sql: string, ...binds: unknown[]) => env.DB_NA.prepare(sql).bind(...binds).all<T>().then((r) => r.results);

describe("markers", () => {
  it("fill in the tax year, the year before and the year after, and the facts of that year", () => {
    const [a] = resolveItems([item("Return for {year}, notice for {year-1}, plan for {year+1}", "RRSP {rrsp_window}")], 2026, facts);
    expect(a.label).toBe("Return for 2026, notice for 2025, plan for 2027");
    expect(a.help).toBe("RRSP A to B 2026");
    expect(JSON.parse(a.tpl!)).toEqual({ label: "Return for {year}, notice for {year-1}, plan for {year+1}", help: "RRSP {rrsp_window}", facts: ["rrsp_window"] });
    expect(restate(a.tpl!, 2027, facts)).toEqual({ label: "Return for 2027, notice for 2026, plan for 2028", help: "RRSP C to D 2027" });
  });

  it("leave text without markers alone, and braces that are not markers", () => {
    const items = [item("Passport"), item("A {client} thing", "{unknown}")];
    expect(resolveItems(items, 2026, facts)).toEqual(items);
  });

  it("refuse a year the facts do not cover", () => {
    expect(() => resolveItems([item("{rrsp_window}")], 2028, facts)).toThrow(UnknownYear);
    const [a] = resolveItems([item("{rrsp_window}")], 2027, facts);
    expect(() => restate(a.tpl!, 2028, facts)).toThrow(UnknownYear);
    expect(() => restate(a.tpl!, 2028, {})).toThrow(UnknownYear);
  });

  it("offer the years the facts cover, or the recent ones, and suggest last calendar year", () => {
    const now = Date.UTC(2027, 0, 12);
    expect(taxYears([item("{rrsp_window}")], facts, now)).toEqual([2026, 2027]);
    expect(taxYears([item("Notice for {year-1}")], facts, now)).toEqual([2022, 2023, 2024, 2025, 2026, 2027, 2028]);
    expect(suggestedYear([2026, 2027], now)).toBe(2026);
    expect(suggestedYear([2027], now)).toBe(2027);
    expect(suggestedYear([2022, 2023, 2024, 2025, 2026, 2027, 2028], Date.UTC(2027, 5, 1))).toBe(2026);
    expect(tax([item("Passport")], undefined, now)).toBeNull();
  });
});

describe("the built-in tax checklists", () => {
  it("all use markers, and the personal one covers the years it has facts for", async () => {
    const { cookie } = await setup();
    const list = await (await api("/api/templates", { cookie })).json<any[]>();
    const by = (id: string) => list.find((t) => t.id === id);
    expect(by("t1-personal").tax).toEqual({ years: [2026], suggested: 2026 });
    expect(by("t1-personal").facts).toBeUndefined();
    for (const id of ["t1-self-employed", "t2-year-end"]) expect([id, by(id).tax.years.includes(new Date().getUTCFullYear() - 1)]).toEqual([id, true]);
    expect(by("ircc-study-permit").tax).toBeNull();
    expect(by("client-onboarding").tax).toBeNull();
  });
});

describe("a request for a tax year", () => {
  it("has every marker filled in for the year", async () => {
    const { cookie, client } = await setup();
    const res = await make(cookie, client.id, { template_id: "t1-personal", tax_year: 2026 });
    expect(res.status).toBe(201);
    const req = await res.json<any>();
    const text = JSON.stringify(req.items);
    const marked = req.items.some((i: any) => /\{[a-z0-9+-]+\}/.test(`${i.label} ${i.help}`));
    expect(labels(req)).toContain("Notice of assessment for 2025");
    expect(labels(req)).toContain("Did your marital status change in 2026?");
    expect(labels(req)).toContain("Were you a resident of Quebec on December 31, 2026?");
    expect(text).toContain("Contributions from March 3, 2026 to March 1, 2027 can go on the 2026 return. Your 2025 notice of assessment");
    expect(text).toContain("For 2026 only the detailed method is available");
    expect(marked).toBe(false);
    expect((await q("SELECT tax_year, template_ref FROM requests"))[0]).toEqual({ tax_year: 2026, template_ref: "t1-personal" });
  });

  it("fills in a copy the account posted, with the facts of the checklist it names", async () => {
    const { cookie, client } = await setup();
    const t1 = builtin("t1-personal");
    const res = await make(cookie, client.id, { items: t1.items.slice(0, 3), tax_year: 2026, template_ref: "t1-personal" });
    expect(labels(await res.json<any>())[0]).toBe("Notice of assessment for 2025");
  });

  it("needs a year it knows, when the checklist has markers", async () => {
    const { cookie, client } = await setup();
    const refused = async (extra: Record<string, unknown>) => {
      const res = await make(cookie, client.id, extra);
      return [res.status, (await res.json<any>()).error];
    };
    expect(await refused({ template_id: "t1-personal" })).toEqual([400, "tax_year_needed"]);
    expect(await refused({ template_id: "t1-personal", tax_year: 2027 })).toEqual([400, "tax_year_unknown"]);
    expect(await refused({ template_id: "t1-personal", tax_year: "2026" })).toEqual([400, "invalid"]);
    expect(await refused({ template_id: "t2-year-end", tax_year: 1999 })).toEqual([400, "invalid"]);
    expect((await make(cookie, client.id, { template_id: "t2-year-end", tax_year: Y })).status).toBe(201);
    expect((await q("SELECT COUNT(*) AS n FROM requests"))[0].n).toBe(1);
  });

  it("is unchanged when the checklist has no markers", async () => {
    const { cookie, client } = await setup();
    const res = await make(cookie, client.id, { template_id: "client-onboarding" });
    expect(res.status).toBe(201);
    expect((await q("SELECT tax_year FROM requests"))[0].tax_year).toBeNull();
    expect((await q("SELECT COUNT(*) AS n FROM items WHERE tpl_json IS NOT NULL"))[0].n).toBe(0);
  });
});

describe("repeating a request moves the tax year on", () => {
  it("fills in the next year's wording where the checklist has its facts", async () => {
    const { cookie, client } = await setup();
    const first = await (await make(cookie, client.id, { template_id: "t2-year-end", tax_year: Y, title: `T2 ${Y}` })).json<any>();
    expect(labels(first)).toContain(`T2 return and notice of assessment for ${Y - 1}`);
    const next = await (await repeat(cookie, first.id)).json<any>();
    expect(next.title).toBe(`T2 ${Y + 1}`);
    expect(labels(next)).toContain(`T2 return and notice of assessment for ${Y}`);
    expect(labels(next)).not.toContain(`T2 return and notice of assessment for ${Y - 1}`);
    expect((await q("SELECT tax_year, template_ref FROM requests WHERE id = ?", next.id))[0]).toEqual({ tax_year: Y + 1, template_ref: "t2-year-end" });
  });

  it("leaves an item the account reworded as it is", async () => {
    const { cookie, client } = await setup();
    const first = await (await make(cookie, client.id, { template_id: "t2-year-end", tax_year: Y })).json<any>();
    const at = first.items.find((i: any) => i.label.startsWith("T2 return"));
    expect((await api(`/api/requests/${first.id}/items/${at.id}`, { method: "PATCH", cookie, body: { label: "Last return and notice" } })).status).toBe(200);
    const next = await (await repeat(cookie, first.id)).json<any>();
    expect(labels(next)).toContain("Last return and notice");
    expect(labels(next).filter((l: string) => l.includes(String(Y - 1)))).toEqual([]);
  });

  it("waits until the next year's dates are known", async () => {
    const { cookie, client } = await setup();
    const first = await (await make(cookie, client.id, { template_id: "t1-personal", tax_year: 2026 })).json<any>();
    const res = await repeat(cookie, first.id);
    expect([res.status, (await res.json<any>()).error]).toEqual([409, "tax_year_unknown"]);
    expect((await q("SELECT COUNT(*) AS n FROM requests"))[0].n).toBe(1);
  });

  it("leaves a request made before tax years alone", async () => {
    const { cookie, client } = await setup();
    const first = await (await make(cookie, client.id, { title: "2025 taxes", items: [item("Slip 2025")] })).json<any>();
    const next = await (await repeat(cookie, first.id)).json<any>();
    expect([next.title, labels(next)]).toEqual(["2026 taxes", ["Slip 2025"]]);
  });
});

describe("what counts as a marker", () => {
  it("is only the exact year forms and the known facts", () => {
    const items = [item("{years} and {year_end} and {yearly}", "{client} {year-}")];
    expect(resolveItems(items, 2026, facts)).toEqual(items);
    expect(tax(items, facts)).toBeNull();
  });

  it("does not make a request ask for a tax year", async () => {
    const { cookie, client } = await setup();
    const res = await make(cookie, client.id, { items: [item("Slip for {year_end}")] });
    expect(res.status).toBe(201);
  });
});

describe("an item reworded after the request was made", () => {
  async function made() {
    const { cookie, client } = await setup();
    const req = await (await make(cookie, client.id, { template_id: "t2-year-end", tax_year: Y })).json<any>();
    const at = req.items.find((i: any) => i.label.startsWith("T2 return"));
    return { cookie, req, at };
  }
  const edit = (cookie: string, req: any, at: any, body: unknown) => api(`/api/requests/${req.id}/items/${at.id}`, { method: "PATCH", cookie, body });

  it("keeps its original wording when it is saved as it was", async () => {
    const { cookie, req, at } = await made();
    await edit(cookie, req, at, { label: at.label, help: at.help, required: false });
    const next = await (await repeat(cookie, req.id)).json<any>();
    expect(labels(next)).toContain(`T2 return and notice of assessment for ${Y}`);
  });

  it("fills in a year marker typed into it, and needs the request to have a tax year", async () => {
    const { cookie, req, at } = await made();
    expect((await edit(cookie, req, at, { label: "Return for {year-1}" })).status).toBe(200);
    expect(labels(await (await api(`/api/requests/${req.id}`, { cookie })).json<any>())).toContain(`Return for ${Y - 1}`);
    const added = await api(`/api/requests/${req.id}/items`, { method: "POST", cookie, body: { label: "Slip {year}", required: true } });
    expect((await added.json<any>()).label).toBe(`Slip ${Y}`);
    const plain = await (await make(cookie, (await q("SELECT client_id FROM requests"))[0].client_id, { items: [item("A")] })).json<any>();
    const res = await api(`/api/requests/${plain.id}/items`, { method: "POST", cookie, body: { label: "Slip {year}", required: true } });
    expect([res.status, (await res.json<any>()).error]).toEqual([400, "tax_year_needed"]);
  });

  it("is listed when Repeat finds it still names a year near the old one", async () => {
    const { cookie, req, at } = await made();
    await edit(cookie, req, at, { label: `Return for ${Y - 1} only` });
    const next = await (await repeat(cookie, req.id)).json<any>();
    expect(next.stale_years).toEqual([`Return for ${Y - 1} only`]);
  });
});

describe("a request from a copy that was deleted", () => {
  it("finds the built-in facts in its place", async () => {
    const { cookie, client } = await setup();
    const t1 = builtin("t1-personal");
    const copy = await (await api("/api/templates", { method: "POST", cookie, body: { name: "Mine", items: t1.items, source: "t1-personal" } })).json<any>();
    const first = await (await make(cookie, client.id, { template_id: copy.id, tax_year: 2026 })).json<any>();
    await api(`/api/templates/${copy.id}`, { method: "DELETE", cookie });
    const firmId = (await q("SELECT firm_id FROM requests"))[0].firm_id;
    expect((await factsOf(env.DB_NA, firmId, copy.id))[2026].rrsp_window).toBe("March 3, 2026 to March 1, 2027");
    const res = await repeat(cookie, first.id);
    expect([res.status, (await res.json<any>()).error]).toEqual([409, "tax_year_unknown"]);
    const t2 = await (await make(cookie, client.id, { items: [item("Slip {rrsp_window}")], template_ref: "t1-personal", tax_year: 2026 })).json<any>();
    expect(labels(t2)).toEqual(["Slip March 3, 2026 to March 1, 2027"]);
  });
});

describe("a batch for a tax year", () => {
  const ADDRESS = "12 King St W\nToronto ON M5H 1A1";
  async function ready() {
    const cookie = await login("owner@firm.test");
    await api("/api/firm", { method: "PATCH", cookie, body: { name: "Tuna Tax", address: ADDRESS } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    const rows = [{ name: "Ann", email: "ann@mail.test" }, { name: "Bo", email: "bo@mail.test" }];
    expect((await api("/api/clients/import", { method: "POST", cookie, body: { rows, import_id: randomId(), contact_ok: true } })).status).toBe(200);
    const firm = await firmRow(cookie);
    const ids = (await q<{ id: string }>("SELECT id FROM clients WHERE firm_id = ? ORDER BY name", firm.id)).map((r) => r.id);
    return { cookie, ids };
  }
  const batch = (cookie: string, ids: string[], extra: Record<string, unknown>) =>
    api("/api/batches", { method: "POST", cookie, body: { client_ids: ids, title: "{year} taxes", deadline: inDays(60), reminders_on: false, ...extra } });

  it("fills in every request's checklist and names the year in the title", async () => {
    const { cookie, ids } = await ready();
    const res = await batch(cookie, ids, { template_id: "t1-personal", tax_year: 2026 });
    expect(res.status).toBe(201);
    const requests = await q("SELECT id, title, tax_year, template_ref FROM requests");
    expect(requests.map((r) => [r.title, r.tax_year, r.template_ref])).toEqual([["2026 taxes", 2026, "t1-personal"], ["2026 taxes", 2026, "t1-personal"]]);
    const rows = await q("SELECT label, help FROM items");
    expect(JSON.stringify(rows)).toContain("Did your marital status change in 2026?");
    expect(rows.some((i) => /\{[a-z0-9+-]+\}/.test(`${i.label} ${i.help}`))).toBe(false);
  });

  it("needs a year it knows", async () => {
    const { cookie, ids } = await ready();
    expect((await (await batch(cookie, ids, { template_id: "t1-personal" })).json<any>()).error).toBe("tax_year_needed");
    expect((await (await batch(cookie, ids, { template_id: "t1-personal", tax_year: 2027 })).json<any>()).error).toBe("tax_year_unknown");
    expect(await q("SELECT 1 FROM requests")).toHaveLength(0);
  });

  it("moves a repeated batch to the next tax year", async () => {
    const { cookie, ids } = await ready();
    const made = [];
    for (const id of ids) made.push(await (await make(cookie, id, { template_id: "t2-year-end", tax_year: Y, title: `T2 ${Y}`, deadline: inDays(40) })).json<any>());
    const res = await api("/api/batches", { method: "POST", cookie, body: { request_ids: made.map((r) => r.id), title: "Repeat", reminders_on: false } });
    expect(res.status).toBe(201);
    const next = await q("SELECT id, title, tax_year FROM requests WHERE tax_year = ? ORDER BY id", Y + 1);
    expect(next.map((r) => [r.title, r.tax_year])).toEqual([[`T2 ${Y + 1}`, Y + 1], [`T2 ${Y + 1}`, Y + 1]]);
    const rows = await q("SELECT label FROM items WHERE request_id IN (SELECT id FROM requests WHERE tax_year = ?)", Y + 1);
    expect(rows.map((r) => r.label).filter((l) => l.startsWith("T2 return"))).toEqual([`T2 return and notice of assessment for ${Y}`, `T2 return and notice of assessment for ${Y}`]);
  });
});

describe("a copy of a built-in checklist", () => {
  const copy = (cookie: string) => api("/api/templates", { method: "POST", cookie, body: { name: "Mine", items: builtin("t1-personal").items, source: "t1-personal" } });

  it("keeps the facts it was copied with and says when the built-in has newer ones", async () => {
    const { cookie, client } = await setup();
    const made = await (await copy(cookie)).json<any>();
    expect(made).toMatchObject({ newer: false, tax: { years: [2026], suggested: 2026 } });
    expect((await q("SELECT source_id FROM templates"))[0].source_id).toBe("t1-personal");
    const older = { 2025: { rrsp_window: "March 4, 2025 to March 3, 2026", wfh_rule: "older rule" } };
    await env.DB_NA.prepare("UPDATE templates SET facts_json = ?").bind(JSON.stringify(older)).run();
    const listed = await (await api("/api/templates", { cookie })).json<any[]>();
    expect(listed.find((t) => t.id === made.id)).toMatchObject({ newer: true, tax: { years: [2025] } });

    const own = await make(cookie, client.id, { template_id: made.id, tax_year: 2025 });
    expect(JSON.stringify((await own.json<any>()).items)).toContain("Contributions from March 4, 2025 to March 3, 2026 can go on the 2025 return");
    expect((await make(cookie, client.id, { template_id: made.id, tax_year: 2026 })).status).toBe(400);

    const updated = await (await api(`/api/templates/${made.id}/facts`, { method: "POST", cookie })).json<any>();
    expect(updated).toMatchObject({ newer: false, tax: { years: [2026] } });
    expect((await make(cookie, client.id, { template_id: made.id, tax_year: 2026 })).status).toBe(201);
  });

  it("has nothing to update without a built-in behind it", async () => {
    const { cookie } = await setup();
    const own = await (await api("/api/templates", { method: "POST", cookie, body: { name: "Plain", items: [item("A {year-1} slip")] } })).json<any>();
    expect(own).toMatchObject({ newer: false, tax: { years: expect.any(Array) } });
    const res = await api(`/api/templates/${own.id}/facts`, { method: "POST", cookie });
    expect([res.status, (await res.json<any>()).error]).toEqual([409, "no_source"]);
    expect((await api(`/api/templates/${randomId()}/facts`, { method: "POST", cookie })).status).toBe(404);
  });
});
