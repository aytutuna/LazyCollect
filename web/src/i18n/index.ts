import en from "./en.json";

const dict: Record<string, string> = en;
const plural = new Intl.PluralRules("en");

export function t(key: string, vars: Record<string, string | number> = {}): string {
  let s = typeof vars.n === "number" ? (dict[`${key}_${plural.select(vars.n)}`] ?? dict[key]) : dict[key];
  s ??= key;
  return s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}
