import { describe, expect, it } from "vitest";
import { checkConditions } from "../src/questions";
import { builtinTemplates, parseItems } from "../src/templates";
import { api, inDays, login, setup } from "./helpers";

const IDS = [
  "t1-personal",
  "t1-self-employed",
  "t2-year-end",
  "bookkeeping-month-end",
  "gst-hst-return",
  "client-onboarding",
  "ircc-express-entry",
  "ircc-spousal-sponsorship",
  "ircc-study-permit",
  "ircc-pgwp",
  "ircc-work-permit",
  "ircc-work-permit-extension",
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

describe("built-in templates", () => {
  it("parse as items, point at earlier unconditional questions and keep labels unique", async () => {
    for (const t of builtinTemplates) {
      expect([t.id, parseItems(t.items)?.length]).toEqual([t.id, t.items.length]);
      expect([t.id, checkConditions(t.items)]).toEqual([t.id, true]);
      const labels = t.items.map((i) => i.label);
      expect([t.id, labels.length - new Set(labels).size]).toEqual([t.id, 0]);
    }
  });

  it("gives the Canadian templates questions with conditional documents", async () => {
    for (const id of ["t1-personal", "t2-year-end", "bookkeeping-month-end", "gst-hst-return", "client-onboarding"]) {
      const t = builtinTemplates.find((x) => x.id === id)!;
      expect(t.items.some((i) => i.kind === "yesno")).toBe(true);
      expect(t.items.some((i) => i.show_if)).toBe(true);
    }
  });

  it("asks the personal checklist about tax year 2026 and no other", () => {
    const t = builtinTemplates.find((x) => x.id === "t1-personal")!;
    const text = JSON.stringify(t);
    expect(t.name).toContain("2026");
    expect(text).not.toMatch(/2025 (tax|net|return)|in 2025|for 2024|, 2025|2024 notice/);
    expect(text).toContain("March 3, 2026 to March 1, 2027");
  });

  it("start a request with the conditions in place", async () => {
    const { cookie, client } = await setup();
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "t", deadline: inDays(5), template_id: "t1-personal" } })).json<any>();
    const rl = req.items.find((i: any) => i.label.startsWith("RL-1 "));
    expect(req.items[rl.show_if_pos].label).toBe("Were you a resident of Quebec on December 31, 2026?");
    expect(rl.show_if_value).toBe("yes");
    expect(rl.hidden).toBe(true);
  });

  it("never ask for the SIN card itself", async () => {
    const sin = builtinTemplates.flatMap((t) => t.items).filter((i) => /\bSIN\b|social insurance/i.test(i.label));
    for (const i of sin) expect(i.required).toBe(false);
  });
});

describe("the T1 organizer", () => {
  const t1 = builtinTemplates.find((t) => t.id === "t1-personal")!;
  const find = (label: RegExp) => t1.items.findIndex((i) => label.test(i.label));

  it("asks about sales and hangs the sale details on that question", () => {
    const q = find(/sell a home, other property or crypto/);
    const details = t1.items[find(/Sale and cost details/)];
    expect(t1.items[q].kind).toBe("yesno");
    expect(details.show_if).toEqual({ item: q, value: "yes" });
    expect(details.help).toContain("principal residence");
  });

  it("has partnership slips, instalment records and the RL-6 slip as optional documents", () => {
    for (const label of [/T5013/, /Instalment payment/, /RL-6/]) {
      const i = t1.items[find(label)];
      expect([label.source, i.required]).toEqual([label.source, false]);
    }
  });

  it("points Home Buyers' Plan details to CRA My Account", () => {
    const hbp = t1.items[find(/Home Buyers' Plan details/)];
    expect(hbp.help).toContain("CRA My Account");
    expect(hbp.help).not.toContain("issuer");
  });
});
