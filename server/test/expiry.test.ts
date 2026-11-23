import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { atHour } from "../src/tz";
import { DAY, MINUTE } from "../src/util";
import { api, review, setup } from "./helpers";

// a deadline is the end of a day in the account's zone, as the form makes it
const TZ = "America/Toronto";
const dayIso = (offset: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now() + offset * DAY);
const endOfDay = (offset: number) => {
  const [y, m, d] = dayIso(offset).split("-").map(Number);
  return atHour({ y, m, d }, 23, TZ) + 59 * MINUTE;
};

const ITEMS = [
  { label: "Passport", required: true, expiry: "expiry" },
  { label: "Police certificate", required: true, expiry: "issue", valid_months: 6 },
  { label: "Photo", required: false },
];

async function make(over: Record<string, unknown> = {}, items: unknown[] = ITEMS) {
  const { cookie, client } = await setup();
  const res = await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "Work permit", deadline: endOfDay(30), items, ...over } });
  const req = await res.json<any>();
  const link = await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>();
  return { cookie, client, req, path: `/api/c/${link.url.split("/c/")[1]}`, res };
}

const view = async (cookie: string, id: string) => (await api(`/api/requests/${id}`, { cookie })).json<any>();
const setItem = (id: string, fields: string, ...binds: unknown[]) => env.DB_NA.prepare(`UPDATE items SET ${fields} WHERE id = ?`).bind(...binds, id).run();
const sqlDate = async (date: string, mod: string) => (await env.DB_NA.prepare("SELECT date(?, ?) AS d").bind(date, mod).first<any>())!.d as string;
const dates = (path: string, item: string, body: unknown) => api(`${path}/items/${item}/dates`, { method: "PUT", body });

describe("dates on a document", () => {
  it("are saved as the client gives them and sent back with the page", async () => {
    const { path, req } = await make();
    const [passport, police] = req.items;
    const res = await dates(path, passport.id, { expires_on: "2031-05-01" });
    expect(res.status).toBe(200);
    const items = (await res.json<any>()).items;
    expect(items[0]).toMatchObject({ expiry_rule: "expiry", expires_on: "2031-05-01", issued_on: null });
    expect((await dates(path, police.id, { issued_on: "2026-01-15" })).status).toBe(200);
    const page = await (await api(path)).json<any>();
    expect(page.items.map((i: any) => [i.expiry_rule, i.valid_months, i.expires_on, i.issued_on])).toEqual([
      ["expiry", null, "2031-05-01", null],
      ["issue", 6, null, "2026-01-15"],
      [null, null, null, null],
    ]);
    // the date is cleared by sending nothing
    await dates(path, passport.id, { expires_on: null });
    expect((await env.DB_NA.prepare("SELECT expires_on FROM items WHERE id = ?").bind(passport.id).first<any>())!.expires_on).toBeNull();
    const audit = await env.DB_NA.prepare("SELECT actor_type, meta FROM audit WHERE action = 'item.dates'").all<any>();
    expect(audit.results.map((a) => a.actor_type)).toEqual(["client", "client", "client"]);
    expect(JSON.stringify(audit.results)).not.toContain("2031");
  });

  it("are refused when invalid, for a document that asks for none, once approved, on hold and past the link", async () => {
    const { cookie, path, req } = await make();
    const [passport, , photo] = req.items;
    for (const bad of [{}, { expires_on: "2031-02-30" }, { expires_on: "soon" }, { expires_on: 20310501 }, { expires_on: "1800-01-01" }]) {
      expect([bad, (await dates(path, passport.id, bad)).status]).toEqual([bad, 400]);
    }
    expect((await dates(path, photo.id, { expires_on: "2031-05-01" })).status).toBe(409);
    expect((await dates(path, "0".repeat(32), { expires_on: "2031-05-01" })).status).toBe(409);
    await setItem(passport.id, "status = 'approved'");
    expect((await dates(path, passport.id, { expires_on: "2031-05-01" })).status).toBe(409);
    await setItem(passport.id, "status = 'empty'");
    await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: true } });
    expect(await (await dates(path, passport.id, { expires_on: "2031-05-01" })).json()).toEqual({ error: "legal_hold" });
    await api(`/api/requests/${req.id}/hold`, { method: "PUT", cookie, body: { on: false } });
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    expect((await dates(path, passport.id, { expires_on: "2031-05-01" })).status).toBe(404);
    expect((await dates(`/api/c/na_${"a".repeat(43)}`, passport.id, { expires_on: "2031-05-01" })).status).toBe(404);
  });

  it("are entered or corrected by the account, and the months only for a document counted from its issue date", async () => {
    const { cookie, req } = await make();
    const [passport, police, photo] = req.items;
    const patch = (item: any, body: unknown) => api(`/api/requests/${req.id}/items/${item.id}`, { method: "PATCH", cookie, body });
    const a = await patch(passport, { expires_on: "2031-05-01" });
    expect([a.status, (await a.json<any>()).valid_to]).toEqual([200, "2031-05-01"]);
    const b = await patch(police, { issued_on: "2026-01-15", valid_months: 12 });
    expect(await b.json()).toMatchObject({ issued_on: "2026-01-15", valid_months: 12, valid_to: "2027-01-15" });
    expect((await patch(passport, { valid_months: 6 })).status).toBe(400);
    expect((await patch(photo, { expires_on: "2031-05-01" })).status).toBe(400);
    expect((await patch(police, { valid_months: 0 })).status).toBe(400);
    expect((await patch(police, { valid_months: 121 })).status).toBe(400);
    expect((await patch(police, { issued_on: "tomorrow" })).status).toBe(400);
    expect((await patch({ id: "0".repeat(32) }, { expires_on: "2031-05-01" })).status).toBe(404);
    expect((await (await patch(passport, { expires_on: null })).json<any>()).valid_to).toBeNull();
    const meta = await env.DB_NA.prepare("SELECT meta FROM audit WHERE action = 'item.edit'").all<any>();
    expect(JSON.stringify(meta.results)).not.toContain("2031");
  });

  it("let an item asking for a date be added to a request", async () => {
    const { cookie, req } = await make();
    const res = await api(`/api/requests/${req.id}/items`, { method: "POST", cookie, body: { label: "Medical", expiry: "issue", valid_months: 12 } });
    expect(await res.json()).toMatchObject({ expiry_rule: "issue", valid_months: 12, valid_to: null });
  });
});

describe("expiry flags", () => {
  it("default to the deadline plus six months and can be set", async () => {
    const { cookie, req } = await make();
    expect(req.valid_until_set).toBe(false);
    expect(req.valid_until).toBe(await sqlDate(dayIso(30), "+6 months"));
    const set = await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { valid_until: "2027-12-31" } });
    expect(await set.json()).toMatchObject({ valid_until: "2027-12-31", valid_until_set: true });
    const reset = await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { valid_until: null } });
    expect(await reset.json()).toMatchObject({ valid_until: await sqlDate(dayIso(30), "+6 months"), valid_until_set: false });
    for (const bad of ["soon", "2027-13-01", 5]) expect((await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { valid_until: bad } })).status).toBe(400);
    const created = await make({ valid_until: "2028-01-31" });
    expect(created.req).toMatchObject({ valid_until: "2028-01-31", valid_until_set: true });
    const refused = await api("/api/requests", { method: "POST", cookie, body: { client_id: req.client_id, title: "x", deadline: endOfDay(30), valid_until: "never" } });
    expect(refused.status).toBe(400);
  });

  it("mark a document that expired, one that ends before the date it must last to, and one that ends soon", async () => {
    const { cookie, req } = await make({ valid_until: dayIso(200) });
    const [passport] = req.items;
    await setItem(passport.id, "status = 'submitted'");
    const flag = async (expires: string | null) => {
      await setItem(passport.id, "expires_on = ?", expires);
      return (await view(cookie, req.id)).items[0].expiry_flag;
    };
    expect(await flag(dayIso(-10))).toBe("expired");
    expect(await flag(dayIso(-1))).toBe("expired");
    expect(await flag(dayIso(0))).toBe("short");
    expect(await flag(dayIso(100))).toBe("short");
    expect(await flag(dayIso(199))).toBe("short");
    expect(await flag(dayIso(200))).toBeNull();
    expect(await flag(dayIso(400))).toBeNull();
    expect(await flag(null)).toBeNull();
    // with the date the document must last to close, a document ending in 60 days is soon rather than short
    await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { valid_until: dayIso(30) } });
    expect(await flag(dayIso(60))).toBe("soon");
    expect(await flag(dayIso(91))).toBeNull();
  });

  it("measure a document counted from its issue date against the deadline", async () => {
    const { cookie, req } = await make();
    const police = req.items[1];
    await setItem(police.id, "status = 'approved'");
    const flag = async (issued: string) => {
      await setItem(police.id, "issued_on = ?", issued);
      return (await view(cookie, req.id)).items[1].expiry_flag;
    };
    expect(await flag(dayIso(-250))).toBe("expired");
    // a document good for six months from 170 days ago ends in about ten days, before the deadline in thirty
    expect(await flag(dayIso(-170))).toBe("short");
    // from 100 days ago it ends in about 80, after the deadline but still close
    expect(await flag(dayIso(-100))).toBe("soon");
    expect(await flag(dayIso(-20))).toBeNull();
  });

  it("only count documents that have come in and apply", async () => {
    const { cookie, req } = await make();
    const [passport] = req.items;
    await setItem(passport.id, "expires_on = ?", dayIso(-10));
    for (const status of ["empty", "rejected", "unavailable", "waived"]) {
      await setItem(passport.id, "status = ?", status);
      expect([status, (await view(cookie, req.id)).items[0].expiry_flag]).toEqual([status, null]);
    }
    await setItem(passport.id, "status = 'approved'");
    expect((await view(cookie, req.id)).items[0].expiry_flag).toBe("expired");
  });
});

describe("the expiring view on the home page", () => {
  const list = async (cookie: string, query = "?view=expiring") => (await api(`/api/requests${query}`, { cookie })).json<any>();

  it("lists requests with a document that is past, before its date or within 90 days, and counts them", async () => {
    const a = await make();
    const quiet = await api("/api/requests", { method: "POST", cookie: a.cookie, body: { client_id: a.client.id, title: "Quiet", deadline: endOfDay(30), items: ITEMS } });
    const quietReq = await quiet.json<any>();
    await api(`/api/requests/${quietReq.id}/link`, { method: "POST", cookie: a.cookie });
    const draft = await (await api("/api/requests", { method: "POST", cookie: a.cookie, body: { client_id: a.client.id, title: "Draft", deadline: endOfDay(30), items: ITEMS } })).json<any>();
    const [passport] = a.req.items;
    await setItem(passport.id, "status = 'submitted', expires_on = ?", dayIso(40));
    await setItem(quietReq.items[0].id, "status = 'submitted', expires_on = ?", dayIso(900));
    await setItem(draft.items[0].id, "status = 'submitted', expires_on = ?", dayIso(-5));

    const page = await list(a.cookie);
    expect(page.rows.map((r: any) => [r.title, r.expiring, r.expiring_on])).toEqual([["Work permit", 1, dayIso(40)]]);
    expect(page.counts.expiring).toBe(1);
    expect((await list(a.cookie, "")).rows.find((r: any) => r.title === "Quiet").expiring).toBe(0);
    // dates that are fine, or on a document not sent in yet, do not count
    await setItem(passport.id, "status = 'rejected'");
    expect((await list(a.cookie)).rows).toEqual([]);
    await setItem(passport.id, "status = 'approved', expires_on = ?", dayIso(-1));
    expect((await list(a.cookie)).rows).toHaveLength(1);
    // a request that is closed is done with
    await api(`/api/requests/${a.req.id}/close`, { method: "POST", cookie: a.cookie });
    expect((await list(a.cookie)).rows).toEqual([]);
  });

  it("counts a document that ends before the date the request must last to", async () => {
    const { cookie, req } = await make({ valid_until: dayIso(500) });
    await setItem(req.items[0].id, "status = 'approved', expires_on = ?", dayIso(300));
    expect((await list(cookie)).rows.map((r: any) => r.expiring)).toEqual([1]);
    await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { valid_until: dayIso(200) } });
    expect((await list(cookie)).rows).toEqual([]);
  });

  it("does not show another account's documents and ignores hidden ones", async () => {
    const a = await make();
    await setItem(a.req.items[0].id, "status = 'submitted', expires_on = ?", dayIso(-3));
    const b = await setup("b@two.test", "Two Inc");
    expect((await list(b.cookie)).rows).toEqual([]);
    expect((await list(b.cookie)).counts.expiring).toBe(0);
  });

  it("ignores a document that the client's answers hide", async () => {
    const { cookie, req } = await make({}, [{ label: "Changed name?", kind: "yesno", required: true }, { label: "Old passport", expiry: "expiry", show_if: { item: 0, value: "yes" } }]);
    await setItem(req.items[1].id, "status = 'submitted', expires_on = ?", dayIso(-3));
    expect((await list(cookie)).rows).toEqual([]);
    expect((await view(cookie, req.id)).items[1]).toMatchObject({ hidden: true, expiry_flag: null });
    await setItem(req.items[0].id, "answer = 'yes', status = 'submitted'");
    expect((await list(cookie)).rows).toHaveLength(1);
  });
});

describe("sending a document back as expired", () => {
  it("starts its dates over, and keeps them for another reason", async () => {
    const { cookie, req } = await make();
    const [passport, police] = req.items;
    for (const item of [passport, police]) await setItem(item.id, "status = 'submitted', expires_on = '2025-01-01', issued_on = '2025-01-01'");
    expect((await review(cookie, req.id, passport.id, { decision: "reject", reasons: ["expired"] })).status).toBe(200);
    expect((await review(cookie, req.id, police.id, { decision: "reject", reasons: ["blurry"] })).status).toBe(200);
    expect(await env.DB_NA.prepare("SELECT expires_on, issued_on FROM items WHERE id = ?").bind(passport.id).first()).toEqual({ expires_on: null, issued_on: null });
    expect(await env.DB_NA.prepare("SELECT expires_on, issued_on FROM items WHERE id = ?").bind(police.id).first()).toEqual({ expires_on: "2025-01-01", issued_on: "2025-01-01" });
  });
});
