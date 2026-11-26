import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { fromAcceptLanguage, isLang, longDate, textsFor } from "../src/lang";
import { builtinTemplates, builtinsFor } from "../src/templates";
import { api, inDays, mockOutbound, setup } from "./helpers";

const US = /\b(licen[cs]e[sd]?|colou?rs?|in?stall?ments?|enrol(l)?ments?|cheques?|checks and bank)\b/gi;
const words = (text: string) => [...text.matchAll(US)].map((m) => m[0].toLowerCase());
const everyText = (list: { name: string; items: { label: string; help?: string }[] }[]) => list.flatMap((t) => [t.name, ...t.items.flatMap((i) => [i.label, i.help ?? ""])]).join("\n");

describe("Canadian English", () => {
  it("is what a Canadian browser asks for", () => {
    expect(fromAcceptLanguage("en-CA,en;q=0.9")).toBe("en-CA");
    expect(fromAcceptLanguage("fr-CA,en-CA;q=0.8")).toBe("fr-CA");
    expect(fromAcceptLanguage("en-US,en;q=0.9")).toBe("en");
    expect(fromAcceptLanguage("en-GB")).toBe("en");
    expect(fromAcceptLanguage("en")).toBe("en");
    expect(isLang("en-CA")).toBe(true);
    expect(isLang("en-GB")).toBe(false);
  });

  it("writes dates the way US English does, apart from the spelling of words", () => {
    const at = Date.parse("2026-12-01T15:00:00Z");
    expect(longDate(at, "en-CA", "America/Toronto")).toBe("December 1, 2026");
    expect(longDate(at, "en", "America/Toronto")).toBe("December 1, 2026");
  });

  it("uses US English words in a dictionary that has no Canadian text", () => {
    const dict = { en: { a: "color" }, "fr-CA": { a: "couleur" } };
    expect(textsFor(dict, "en-CA").a).toBe("color");
    expect(textsFor({ ...dict, "en-CA": { a: "colour" } }, "en-CA").a).toBe("colour");
  });
});

describe("the built-in checklists in English", () => {
  it("are spelled the US way in the base and the Canadian way in en-CA", () => {
    const us = everyText(builtinsFor("en"));
    const ca = everyText(builtinsFor("en-CA"));
    expect(words(us).filter((w) => /licence|colour|instalment|enrolment|cheque/.test(w))).toEqual([]);
    expect(words(ca).filter((w) => /license|color|installment|enrollment|checks and bank/.test(w))).toEqual([]);
    expect(words(us).length).toBeGreaterThan(0);
    expect(words(us).length).toBe(words(ca).length);
  });

  it("keep the same shape, apart from spelling", () => {
    expect(builtinsFor("en-CA").map((t) => t.id)).toEqual(builtinTemplates.map((t) => t.id));
    builtinTemplates.forEach((t, at) => {
      const ca = builtinsFor("en-CA")[at];
      expect(ca.items.length).toBe(t.items.length);
      t.items.forEach((i, n) => expect({ ...ca.items[n], label: "", help: "" }).toEqual({ ...i, label: "", help: "" }));
    });
  });

  it("come in en-CA when asked for", async () => {
    const { cookie } = await setup();
    const list = await (await api("/api/templates?locale=en-CA", { cookie })).json<any[]>();
    const onboarding = list.find((t) => t.id === "client-onboarding");
    expect(onboarding.locale).toBe("en-CA");
    expect(onboarding.items.find((i: any) => i.label === "Photo ID").help).toContain("licence");
    const us = await (await api("/api/templates?locale=en", { cookie })).json<any[]>();
    expect(us.find((t) => t.id === "client-onboarding").items.find((i: any) => i.label === "Photo ID").help).toContain("license");
  });
});

describe("an account writing Canadian English", () => {
  it("makes requests and emails in en-CA, with the page language marked", async () => {
    const { cookie, client } = await setup();
    await api("/api/firm", { method: "PATCH", cookie, body: { address: "12 King St W\nToronto ON M5H 1A1", locale: "en-CA" } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    const sent = mockOutbound();
    const req = await (
      await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "Taxes", deadline: inDays(30), template_id: "client-onboarding" } })
    ).json<any>();
    expect(req.locale).toBe("en-CA");
    expect(req.items.find((i: any) => i.label === "Photo ID").help).toContain("licence");
    await api(`/api/requests/${req.id}/link`, { method: "POST", cookie, body: { send_email: true } });
    expect(sent.at(-1)!.subject).toBe("Documents requested: Taxes");
    expect(sent.at(-1)!.html).toContain('<html lang="en-CA">');
  });

  it("starts when the browser that signed up asked for Canadian English", async () => {
    const sent = mockOutbound();
    await api("/api/auth/start", { method: "POST", body: { email: "ca@firm.test", turnstile: "tok" }, headers: { "X-Lang": "en-CA" } });
    const res = await api("/api/auth/verify", { method: "POST", body: { email: "ca@firm.test", code: sent[0].text.match(/([0-9]{6})/)![1] }, headers: { "X-Lang": "en-CA" } });
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    expect((await (await api("/api/firm", { cookie })).json<any>()).locale).toBe("en-CA");
  });
});
