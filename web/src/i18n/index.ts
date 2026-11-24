import { useEffect, useState } from "preact/hooks";
import en from "./en.json";
import fr from "./fr-CA.json";

export type Locale = "en" | "fr-CA";
export const LOCALES: Locale[] = ["en", "fr-CA"];

const dicts: Record<Locale, Record<string, string>> = { en, "fr-CA": fr };
const KEY = "lazycollect.lang";

export const isLocale = (v: unknown): v is Locale => v === "en" || v === "fr-CA";

// A saved choice wins, then the browser's list of languages; French of any region means fr-CA.
export function pickLocale(saved: string | null | undefined, browser: readonly string[]): Locale {
  if (isLocale(saved)) return saved;
  for (const tag of browser) {
    const lang = tag.toLowerCase().split("-")[0];
    if (lang === "fr") return "fr-CA";
    if (lang === "en") return "en";
  }
  return "en";
}

function saved(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let current: Locale = pickLocale(saved(), typeof navigator === "undefined" ? [] : navigator.languages);
let plural = new Intl.PluralRules(current);
const listeners = new Set<() => void>();

function apply() {
  plural = new Intl.PluralRules(current);
  if (typeof document !== "undefined") document.documentElement.lang = current;
}
apply();

export const locale = () => current;

// the tag for Intl: Canadian English, not the US default
export const intl = () => (current === "en" ? "en-CA" : current);

// remember is false when a page borrows a language, such as the one a client was given, without it becoming the person's choice
export function setLocale(next: Locale, remember = true) {
  if (next === current && !remember) return;
  current = next;
  if (remember) {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // private mode: the choice lasts until the page is closed
    }
  }
  apply();
  listeners.forEach((l) => l());
}

// true once the person has picked a language themselves
export const chosen = () => isLocale(saved());

// a root component calls this so everything below it draws again after a switch
export function useLocale(): Locale {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return current;
}

const enPlural = new Intl.PluralRules("en");

function find(dict: Record<string, string>, rules: Intl.PluralRules, key: string, n: number | undefined): string | undefined {
  if (n === undefined) return dict[key];
  return dict[`${key}_${rules.select(n)}`] ?? dict[`${key}_other`] ?? dict[key];
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const n = typeof vars.n === "number" ? vars.n : undefined;
  const s = find(dicts[current], plural, key, n) ?? find(en, enPlural, key, n) ?? key;
  return s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}
