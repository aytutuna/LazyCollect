import { describe, expect, it } from "vitest";
import { builtinTemplates } from "../src/templates";
import { builtinTemplatesFr } from "../templates/fr";

const markers = (i: { label: string; help?: string }) => [...`${i.label} ${i.help ?? ""}`.matchAll(/[{][a-z0-9_+-]+[}]/g)].map((m) => m[0]).sort();

describe("French built-in templates", () => {
  it("has a twin for every template, in the same order", () => {
    expect(builtinTemplatesFr.map((t) => t.id)).toEqual(builtinTemplates.map((t) => t.id));
  });

  builtinTemplates.forEach((en, at) => {
    const fr = builtinTemplatesFr[at];

    it(`${en.id} keeps the structure`, () => {
      expect(fr.id).toBe(en.id);
      expect(fr.items.length).toBe(en.items.length);
      en.items.forEach((item, i) => {
        const twin = fr.items[i] as typeof item;
        const where = `${en.id} item ${i}`;
        expect([where, twin.kind]).toEqual([where, item.kind]);
        expect([where, twin.required]).toEqual([where, item.required]);
        expect([where, twin.show_if]).toEqual([where, item.show_if]);
        expect([where, twin.per_person]).toEqual([where, item.per_person]);
        expect([where, twin.expiry]).toEqual([where, item.expiry]);
        expect([where, twin.valid_months]).toEqual([where, item.valid_months]);
        expect([where, twin.translation]).toEqual([where, item.translation]);
        expect([where, twin.example]).toEqual([where, item.example]);
        expect([where, twin.options?.length]).toEqual([where, item.options?.length]);
        expect([where, Boolean(twin.help)]).toEqual([where, Boolean(item.help)]);
        expect([where, markers(twin)]).toEqual([where, markers(item)]);
        expect(twin.label.length).toBeGreaterThan(0);
      });
    });

    it(`${en.id} has the same years and facts`, () => {
      const shape = (facts: Record<number, Record<string, string>> | undefined) => Object.entries(facts ?? {}).map(([year, f]) => [year, Object.keys(f).sort()]);
      expect(shape(fr.facts)).toEqual(shape(en.facts));
    });

    it(`${en.id} is translated`, () => {
      expect(fr.name).not.toBe(en.name);
      expect(fr.items[0].label).not.toBe(en.items[0].label);
    });
  });
});
