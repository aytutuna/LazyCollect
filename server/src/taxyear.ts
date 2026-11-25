import type { Item } from "./questions";

// Checklist text can hold {year}, {year-1} and {year+1}, and named facts such as {rrsp_window} whose wording changes from one
// tax year to the next. The facts of each year are kept with the built-in checklist.
export type Facts = Record<number, Record<string, string>>;

const MARKER = /\{(year(?:[+-]\d{1,2})?|[a-z][a-z0-9_]*)\}/g;
// only these exact forms are year markers; {years} or {year_end} are just text
const YEAR = /^year(?:[+-]\d{1,2})?$/;
const FIRST = 2000;
const LAST = 2100;

export class UnknownYear extends Error {}

export const validYear = (y: unknown): y is number => Number.isInteger(y) && (y as number) >= FIRST && (y as number) <= LAST;

function fill(s: string, year: number, facts: Facts, known: Set<string>, used: Set<string>): string {
  return s.replace(MARKER, (whole, name: string) => {
    if (YEAR.test(name)) return String(year + Number(name.slice(4) || 0));
    if (!known.has(name)) return whole;
    const fact = facts[year]?.[name];
    if (fact === undefined) throw new UnknownYear(name);
    used.add(name);
    return fact;
  });
}

// every fact name any year of this table has; a marker with another name is left as it was typed
const names = (facts: Facts) => new Set(Object.values(facts).flatMap((f) => Object.keys(f)));

const used = (s: string, known: Set<string>) => [...s.matchAll(MARKER)].some((m) => YEAR.test(m[1]) || known.has(m[1]));

// the year markers of a text filled in, for wording typed after a request was made; other markers stay as typed
export const hasYear = (s: string) => [...s.matchAll(MARKER)].some((m) => YEAR.test(m[1]));
export const fillYear = (s: string, year: number) => s.replace(MARKER, (whole, name: string) => (YEAR.test(name) ? String(year + Number(name.slice(4) || 0)) : whole));
const texts = (i: Item) => [i.label, i.help ?? "", ...(i.options ?? [])];

export const hasMarkers = (items: Item[], facts: Facts = {}) => items.some((i) => texts(i).some((s) => used(s, names(facts))));

const usesFacts = (items: Item[], facts: Facts) => items.some((i) => texts(i).some((s) => [...s.matchAll(MARKER)].some((m) => names(facts).has(m[1]))));

// the items with their markers filled in for one tax year; an item that changed keeps its original wording for the next year
export function resolveItems(items: Item[], year: number, facts: Facts): (Item & { tpl?: string })[] {
  const known = names(facts);
  return items.map((i) => {
    const used = new Set<string>();
    const label = fill(i.label, year, facts, known, used);
    const help = i.help === undefined ? undefined : fill(i.help, year, facts, known, used);
    const options = i.options?.map((o) => fill(o, year, facts, known, used));
    if (label === i.label && help === i.help && (options ?? []).every((o, at) => o === i.options![at])) return i;
    return { ...i, label, ...(help === undefined ? {} : { help }), ...(options ? { options } : {}), tpl: JSON.stringify({ label: i.label, help: i.help ?? null, facts: [...used] }) };
  });
}

// the stored original wording of one item, filled in for another year; a fact it used has to be known for that year
export function restate(tpl: string, year: number, facts: Facts): { label: string; help: string | null } {
  const { label, help, facts: used = [] } = JSON.parse(tpl) as { label: string; help: string | null; facts?: string[] };
  const known = new Set([...names(facts), ...used]);
  const sink = new Set<string>();
  return { label: fill(label, year, facts, known, sink), help: help === null ? null : fill(help, year, facts, known, sink) };
}

// the tax years a checklist can be made for: those its facts cover, or the recent ones when it needs none
export function taxYears(items: Item[], facts: Facts | undefined, now = Date.now()): number[] {
  if (facts && usesFacts(items, facts)) return Object.keys(facts).map(Number).sort((a, b) => a - b);
  const current = new Date(now).getUTCFullYear();
  return Array.from({ length: 7 }, (_, i) => current - 5 + i);
}

// last calendar year when the checklist covers it, else the newest it does
export function suggestedYear(years: number[], now = Date.now()): number {
  const last = new Date(now).getUTCFullYear() - 1;
  return [...years].reverse().find((y) => y <= last) ?? years[0];
}

export const tax = (items: Item[], facts: Facts | undefined, now = Date.now()) => {
  if (!hasMarkers(items, facts)) return null;
  const years = taxYears(items, facts, now);
  return { years, suggested: suggestedYear(years, now) };
};
