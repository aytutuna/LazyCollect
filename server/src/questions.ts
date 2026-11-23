import { text } from "./validate";

export const KINDS = ["file", "yesno", "text", "longtext", "number", "date", "choice", "multi"] as const;
export type Kind = (typeof KINDS)[number];

export const MAX_OPTIONS = 20;
const OPTION_LEN = 100;
const TEXT_LEN = 500;
const LONG_TEXT_LEN = 5000;

export type ShowIf = { item: number; value: string };

// who an item is for when it is asked once for each person on a request
export const FILTERS = ["everyone", "adults", "spouse", "children", "principal"] as const;
export type Filter = (typeof FILTERS)[number];

export type Item = {
  label: string;
  help?: string;
  required: boolean;
  kind?: Kind;
  options?: string[];
  show_if?: ShowIf;
  example?: string;
  per_person?: Filter;
  // the date asked for: the day the document expires, or the day it was issued and how many months it counts for
  expiry?: "expiry" | "issue";
  valid_months?: number;
  // the client says whether it is in English or French, and a translation is asked for when it is not
  translation?: boolean;
};

// what a conditional item may hang on
const PARENTS: Kind[] = ["yesno", "choice", "multi"];
const isChoice = (k: Kind) => k === "choice" || k === "multi";
export const isQuestion = (k: string) => k !== "file";

export function parseOptions(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_OPTIONS) return undefined;
  const options = v.map((o) => text(o, OPTION_LEN));
  if (options.some((o) => !o) || new Set(options).size !== options.length) return undefined;
  return options as string[];
}

// the part of an item that says what it asks and when it is shown; undefined when invalid
export function parseKind(o: Record<string, unknown>): Pick<Item, "kind" | "options" | "show_if"> | undefined {
  const kind = o.kind === undefined ? "file" : KINDS.find((k) => k === o.kind);
  if (!kind) return undefined;
  let options: string[] | undefined;
  if (isChoice(kind)) {
    options = parseOptions(o.options);
    if (!options) return undefined;
  } else if (o.options !== undefined && !(Array.isArray(o.options) && !o.options.length)) {
    return undefined;
  }
  let show_if: ShowIf | undefined;
  if (o.show_if !== undefined && o.show_if !== null) {
    const s = o.show_if as Record<string, unknown>;
    const value = typeof s === "object" ? text(s.value, OPTION_LEN) : undefined;
    if (typeof s !== "object" || !Number.isInteger(s.item) || (s.item as number) < 0 || !value) return undefined;
    show_if = { item: s.item as number, value };
  }
  return { ...(kind === "file" ? {} : { kind }), ...(options ? { options } : {}), ...(show_if ? { show_if } : {}) };
}

type Parent = { kind: string; options: string[] | null; conditional: boolean };

type Tags = Pick<Item, "per_person" | "expiry" | "valid_months" | "translation">;

// per_person, expiry and translation belong to items that are always shown; undefined when invalid
export function parseTags(o: Record<string, unknown>, kind: string, conditional: boolean): Tags | undefined {
  const tags: Tags = {};
  if (o.per_person !== undefined) {
    const filter = FILTERS.find((f) => f === o.per_person);
    if (!filter || conditional || PARENTS.includes(kind as Kind)) return undefined;
    tags.per_person = filter;
  }
  if (o.expiry !== undefined) {
    if (kind !== "file" || (o.expiry !== "expiry" && o.expiry !== "issue")) return undefined;
    tags.expiry = o.expiry;
  }
  const months = o.valid_months;
  if (months !== undefined) {
    if (tags.expiry !== "issue" || !Number.isInteger(months) || (months as number) < 1 || (months as number) > 120) return undefined;
    tags.valid_months = months as number;
  } else if (tags.expiry === "issue") {
    return undefined;
  }
  if (o.translation !== undefined) {
    if (typeof o.translation !== "boolean" || (o.translation && (kind !== "file" || conditional))) return undefined;
    if (o.translation) tags.translation = true;
  }
  return tags;
}

// a condition must point at an earlier, unconditional yes/no or choice item and at a value it can have
export function conditionOk(show_if: ShowIf, parent: Parent | undefined): boolean {
  if (!parent || parent.conditional || !PARENTS.includes(parent.kind as Kind)) return false;
  return parent.kind === "yesno" ? show_if.value === "yes" || show_if.value === "no" : Boolean(parent.options?.includes(show_if.value));
}

export function checkConditions(items: Item[]): boolean {
  return items.every((i, at) => {
    if (!i.show_if) return true;
    const p = items[i.show_if.item];
    return i.show_if.item < at && conditionOk(i.show_if, p && { kind: p.kind ?? "file", options: p.options ?? null, conditional: Boolean(p.show_if || p.per_person) });
  });
}

// the answer as it is stored: a string, or a JSON array of options for a multiple choice; null clears it, undefined is invalid
export function parseAnswer(kind: Kind, options: string[] | null, v: unknown): string | null | undefined {
  if (v === null || v === "" || (Array.isArray(v) && !v.length)) return null;
  switch (kind) {
    case "yesno":
      return v === "yes" || v === "no" ? v : undefined;
    case "text":
      return text(v, TEXT_LEN);
    case "longtext":
      return text(v, LONG_TEXT_LEN);
    case "number": {
      // a comma only marks decimals, one or two digits after it; thousands separators are not accepted
      const raw = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
      const s = /^-?\d{1,15},\d{1,2}$/.test(raw) ? raw.replace(",", ".") : raw;
      return /^-?\d{1,15}(\.\d{1,6})?$/.test(s) ? s : undefined;
    }
    case "date": {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
      const d = new Date(`${v}T00:00:00Z`);
      return d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2100 && d.toISOString().startsWith(v) ? v : undefined;
    }
    case "choice":
      return typeof v === "string" && options?.includes(v) ? v : undefined;
    case "multi":
      return Array.isArray(v) && new Set(v).size === v.length && v.every((o) => typeof o === "string" && options?.includes(o)) ? JSON.stringify(v) : undefined;
    default:
      return undefined;
  }
}

// SQL: the item `a` is shown. A conditional item waits for its parent's answer; the parent is never conditional itself.
// The translation question and companions of a document that was waived are not shown either.
// A hidden item never counts as missing, and it is never shown to the client.
export const visible = (a: string) =>
  `((${a}.show_if_pos IS NULL OR EXISTS (SELECT 1 FROM items p WHERE p.firm_id = ${a}.firm_id AND p.request_id = ${a}.request_id
     AND p.position = ${a}.show_if_pos AND p.answer IS NOT NULL
     AND CASE WHEN p.kind = 'multi' THEN EXISTS (SELECT 1 FROM json_each(p.answer) WHERE value = ${a}.show_if_value) ELSE p.answer = ${a}.show_if_value END))
   AND NOT (${a}.for_pos IS NOT NULL AND EXISTS (SELECT 1 FROM items m WHERE m.firm_id = ${a}.firm_id AND m.request_id = ${a}.request_id
     AND m.position = ${a}.for_pos AND m.status = 'waived'))
   )`;

// a calendar date as the table keeps it; null clears one, undefined is not one
export const parseDay = (v: unknown) => (v === null || v === "" ? null : (parseAnswer("date", null, v) as string | undefined));

// SQL: the last day a document with a date is good for, from the rule the item uses; NULL until the date is given
// a month later than a day the month lacks ends on the last day of that month: 31 August and six months is 28 February
export const validTo = (a: string) =>
  `CASE ${a}.expiry_rule WHEN 'expiry' THEN ${a}.expires_on WHEN 'issue' THEN date(date(${a}.issued_on, 'start of month', '+' || ${a}.valid_months || ' months'),
    '+' || (MIN(CAST(strftime('%d', ${a}.issued_on) AS INTEGER), CAST(strftime('%d', date(${a}.issued_on, 'start of month', '+' || (${a}.valid_months + 1) || ' months', '-1 day')) AS INTEGER)) - 1) || ' days') END`;

type Row = { required: number; hidden?: number; translation?: number; options_json: string | null; reject_reasons?: string | null; answer: string | null; kind: string };

export function presentItem<T extends Row>({ options_json, reject_reasons, hidden, translation, ...i }: T) {
  return {
    ...i,
    ...(translation === undefined ? {} : { translation: translation === 1 }),
    reject_reasons: reject_reasons ? (JSON.parse(reject_reasons) as string[]) : [],
    required: i.required === 1,
    ...(hidden === undefined ? {} : { hidden: hidden === 1 }),
    options: options_json ? (JSON.parse(options_json) as string[]) : null,
    answer: i.kind === "multi" && i.answer ? (JSON.parse(i.answer) as string[]) : i.answer,
  };
}

// the columns the account sees on an item
export const ITEM_COLS = `id, position, label, help, required, status, reject_note, reject_reasons, reviewed_at, unavailable_note, kind, example, options_json, show_if_pos, show_if_value, answer, answer_at,
  person_pos, label_base, for_pos, companion, translation, expiry_rule, valid_months, expires_on, issued_on, ${validTo("items")} AS valid_to,
  NOT ${visible("items")} AS hidden`;
