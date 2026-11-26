import { beforeEach, describe, expect, it } from "vitest";
import { setZone, fmtDate, fmtSize, relative } from "../format";
import en from "./en.json";
import enCA from "./en-CA.json";
import fr from "./fr-CA.json";
import { LOCALES, locale, pickLocale, setLocale, t, translate } from "./index";

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("pickLocale", () => {
  it("takes the saved choice before the browser", () => {
    expect(pickLocale("fr-CA", ["en-US"])).toBe("fr-CA");
    expect(pickLocale("en", ["fr-CA"])).toBe("en");
  });

  it("reads French of any region as fr-CA", () => {
    expect(pickLocale(null, ["fr"])).toBe("fr-CA");
    expect(pickLocale(null, ["fr-FR", "en"])).toBe("fr-CA");
    expect(pickLocale(undefined, ["FR-ca"])).toBe("fr-CA");
  });

  it("goes down the browser's list and falls back to English", () => {
    expect(pickLocale(null, ["de-DE", "fr-CA"])).toBe("fr-CA");
    expect(pickLocale(null, ["de-DE", "en-GB"])).toBe("en");
    expect(pickLocale(null, ["de-DE"])).toBe("en");
    expect(pickLocale(null, [])).toBe("en");
  });

  it("reads English from Canada as en-CA and other English as US English", () => {
    expect(pickLocale(null, ["en-CA", "en"])).toBe("en-CA");
    expect(pickLocale(null, ["en-ca"])).toBe("en-CA");
    expect(pickLocale(null, ["en-US", "en-CA"])).toBe("en");
    expect(pickLocale(null, ["en-GB"])).toBe("en");
    expect(pickLocale(null, ["fr-CA", "en-CA"])).toBe("fr-CA");
    expect(pickLocale("en", ["en-CA"])).toBe("en");
  });

  it("ignores a saved value that is not a language we have", () => {
    expect(pickLocale("de", ["fr"])).toBe("fr-CA");
  });
});

describe("every language", () => {
  const dicts: Record<string, Record<string, string>> = { en, "en-CA": enCA, "fr-CA": fr };
  const base = en as Record<string, string>;

  it("has a text for every key of the US English base", () => {
    const rules = new Intl.PluralRules("en");
    for (const l of LOCALES) {
      for (const key of Object.keys(base)) {
        // a key that is not in the language's own file falls back to the US English text, never to the key
        expect([l, key, translate(dicts[l], rules, key)]).not.toEqual([l, key, key]);
      }
    }
  });

  it("keeps the Canadian English file to texts the base has, spelled differently", () => {
    for (const [key, text] of Object.entries(enCA)) {
      expect([key, key in base]).toEqual([key, true]);
      expect([key, text === base[key]]).toEqual([key, false]);
      expect([key, vars(text)]).toEqual([key, vars(base[key])]);
    }
  });

  it("spells US English the US way", () => {
    expect(Object.values(base).join(" ")).not.toMatch(/(cancelled|cheque|colour|licence|instalment|enrolment)/i);
  });
});

describe("the French dictionary", () => {
  it("has every key of the English one and no others", () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });

  it("keeps every placeholder of the English text", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect([key, vars(fr[key])]).toEqual([key, vars(en[key])]);
  });

  it("has no empty text", () => {
    for (const [key, text] of Object.entries(fr)) expect([key, text.trim() === ""]).toEqual([key, false]);
  });
});

describe("t", () => {
  beforeEach(() => setLocale("en", false));

  it("shows Canadians their own spelling", () => {
    setLocale("en-CA", false);
    expect(t("batch.status.cancelled")).toBe("Cancelled");
    expect(t("nav.requests")).toBe("Requests");
    setLocale("en", false);
    expect(t("batch.status.cancelled")).toBe("Canceled");
  });

  it("follows the language that is set", () => {
    setLocale("fr-CA", false);
    expect(locale()).toBe("fr-CA");
    expect(t("nav.requests")).toBe("Demandes");
    setLocale("en", false);
    expect(t("nav.requests")).toBe("Requests");
  });

  it("picks the plural of the language: French counts 0 and 1 as one", () => {
    setLocale("fr-CA", false);
    expect(t("clients.requests", { n: 1 })).toBe("1 demande");
    expect(t("clients.requests", { n: 0 })).toBe("0 demande");
    expect(t("clients.requests", { n: 5 })).toBe("5 demandes");
    setLocale("en", false);
    expect(t("clients.requests", { n: 0 })).toBe("0 requests");
  });

  it("falls back to English for a key a dictionary lacks, then to the key", () => {
    const frOnly = { "nav.requests": "Demandes" };
    const rules = new Intl.PluralRules("fr");
    expect(translate(frOnly, rules, "nav.requests")).toBe("Demandes");
    expect(translate(frOnly, rules, "nav.clients")).toBe("Clients");
    expect(translate(frOnly, rules, "clients.requests", { n: 3 })).toBe("3 requests");
    expect(translate(frOnly, rules, "no.such.key")).toBe("no.such.key");
  });

  it("fills placeholders", () => {
    setLocale("fr-CA", false);
    expect(t("progress", { done: 2, total: 5 })).toBe("2 sur 5 reçus");
  });
});

describe("formats in each language", () => {
  beforeEach(() => setZone("America/Toronto"));

  it("writes dates and sizes the way the language does", () => {
    const day = Date.parse("2026-12-31T17:00:00Z");
    setLocale("en", false);
    expect(fmtDate(day)).toBe("Dec 31, 2026");
    expect(fmtSize(3 * 1024 * 1024)).toBe("3.0 MB");
    setLocale("fr-CA", false);
    expect(fmtDate(day)).toMatch(/^31 déc\.? 2026$/);
    expect(fmtSize(3 * 1024 * 1024)).toMatch(/^3,0 Mo$/);
    expect(fmtSize(2048)).toBe("2 ko");
    expect(relative(Date.now())).toBe("Aujourd'hui");
    setLocale("en", false);
  });
});
