import { beforeEach, describe, expect, it } from "vitest";
import { setZone, fmtDate, fmtSize, relative } from "../format";
import en from "./en.json";
import fr from "./fr-CA.json";
import { locale, pickLocale, setLocale, t } from "./index";

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

  it("ignores a saved value that is not a language we have", () => {
    expect(pickLocale("de", ["fr"])).toBe("fr-CA");
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

  it("falls back to English for a key French lacks, then to the key", () => {
    setLocale("fr-CA", false);
    expect(t("no.such.key")).toBe("no.such.key");
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
