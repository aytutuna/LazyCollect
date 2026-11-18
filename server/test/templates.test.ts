import { describe, expect, it } from "vitest";
import { api, login } from "./helpers";

const IDS = [
  "t1-personal",
  "t1-self-employed",
  "t2-year-end",
  "ircc-express-entry",
  "ircc-spousal-sponsorship",
  "ircc-study-permit",
  "ircc-work-permit",
  "ircc-visitor-visa",
  "ircc-citizenship",
];
const items = [{ label: "Passport", help: "All pages", required: true }, { label: "Visa" }];

const add = (cookie: string, body: Record<string, unknown>) => api("/api/templates", { method: "POST", cookie, body });

describe("templates", () => {
  it("answers 401 without a session", async () => {
    expect((await api("/api/templates")).status).toBe(401);
    expect((await api("/api/templates", { method: "POST", body: {} })).status).toBe(401);
  });

  it("lists the built-in templates", async () => {
    const cookie = await login();
    const list = await (await api("/api/templates", { cookie })).json<any[]>();
    expect(list.map((t) => t.id)).toEqual(IDS);
    for (const t of list) {
      expect(t.builtin).toBe(true);
      expect(t.items.length).toBeGreaterThan(3);
      for (const i of t.items) expect(typeof i.required).toBe("boolean");
    }
    expect(list.flatMap((t) => t.items).some((i: any) => /^SIN\b/.test(i.label))).toBe(false);
  });

  it("creates, updates and deletes a firm template", async () => {
    const cookie = await login();
    const made = await add(cookie, { name: "Mine", items });
    expect(made.status).toBe(201);
    const t = await made.json<any>();
    expect(t).toMatchObject({ name: "Mine", locale: "en", builtin: false });
    expect(t.items).toEqual([{ label: "Passport", help: "All pages", required: true }, { label: "Visa", required: true }]);
    const patched = await api(`/api/templates/${t.id}`, { method: "PATCH", cookie, body: { name: "Renamed", items: [{ label: "One", required: false }] } });
    expect(await patched.json()).toMatchObject({ name: "Renamed", items: [{ label: "One", required: false }] });
    const list = await (await api("/api/templates", { cookie })).json<any[]>();
    expect(list).toHaveLength(IDS.length + 1);
    expect((await api(`/api/templates/${t.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await api(`/api/templates/${t.id}`, { method: "DELETE", cookie })).status).toBe(404);
  });

  it("rejects bad input", async () => {
    const cookie = await login();
    expect((await add(cookie, { items })).status).toBe(400);
    expect((await add(cookie, { name: "A" })).status).toBe(400);
    expect((await add(cookie, { name: "A", items: [] })).status).toBe(400);
    expect((await add(cookie, { name: "A", items: [{ label: "" }] })).status).toBe(400);
    expect((await add(cookie, { name: "A", items: [{ label: "x", required: "yes" }] })).status).toBe(400);
    expect((await add(cookie, { name: "A", items: Array(101).fill({ label: "x" }) })).status).toBe(400);
    expect((await add(cookie, { name: "A", items, locale: "de" })).status).toBe(400);
    const t = await (await add(cookie, { name: "A", items })).json<any>();
    expect((await api(`/api/templates/${t.id}`, { method: "PATCH", cookie, body: {} })).status).toBe(400);
  });

  it("leaves built-in templates alone", async () => {
    const cookie = await login();
    expect((await api("/api/templates/t1-personal", { method: "PATCH", cookie, body: { name: "x" } })).status).toBe(404);
    expect((await api("/api/templates/t1-personal", { method: "DELETE", cookie })).status).toBe(404);
  });

  it("hides another firm's templates behind 404", async () => {
    const a = await login("a@one.test");
    const b = await login("b@two.test");
    const t = await (await add(a, { name: "Mine", items })).json<any>();
    const list = await (await api("/api/templates", { cookie: b })).json<any[]>();
    expect(list.some((x) => x.id === t.id)).toBe(false);
    expect((await api(`/api/templates/${t.id}`, { method: "PATCH", cookie: b, body: { name: "x" } })).status).toBe(404);
    expect((await api(`/api/templates/${t.id}`, { method: "DELETE", cookie: b })).status).toBe(404);
  });
});
