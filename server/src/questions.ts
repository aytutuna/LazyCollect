import { text } from "./validate";

export const KINDS = ["file", "yesno", "text", "longtext", "number", "date", "choice", "multi"] as const;
export type Kind = (typeof KINDS)[number];

export const MAX_OPTIONS = 20;
const OPTION_LEN = 100;
const TEXT_LEN = 500;
const LONG_TEXT_LEN = 5000;

export type ShowIf = { item: number; value: string };
export type Item = { label: string; help?: string; required: boolean; kind?: Kind; options?: string[]; show_if?: ShowIf };

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

// a condition must point at an earlier, unconditional yes/no or choice item and at a value it can have
export function conditionOk(show_if: ShowIf, parent: Parent | undefined): boolean {
  if (!parent || parent.conditional || !PARENTS.includes(parent.kind as Kind)) return false;
  return parent.kind === "yesno" ? show_if.value === "yes" || show_if.value === "no" : Boolean(parent.options?.includes(show_if.value));
}

export function checkConditions(items: Item[]): boolean {
  return items.every((i, at) => {
    if (!i.show_if) return true;
    const p = items[i.show_if.item];
    return i.show_if.item < at && conditionOk(i.show_if, p && { kind: p.kind ?? "file", options: p.options ?? null, conditional: Boolean(p.show_if) });
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
      const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
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
// A hidden item never counts as missing, and it is never shown to the client.
export const visible = (a: string) =>
  `(${a}.show_if_pos IS NULL OR EXISTS (SELECT 1 FROM items p WHERE p.firm_id = ${a}.firm_id AND p.request_id = ${a}.request_id
     AND p.position = ${a}.show_if_pos AND p.answer IS NOT NULL
     AND CASE WHEN p.kind = 'multi' THEN EXISTS (SELECT 1 FROM json_each(p.answer) WHERE value = ${a}.show_if_value) ELSE p.answer = ${a}.show_if_value END))`;

type Row = { required: number; hidden?: number; options_json: string | null; answer: string | null; kind: string };

export function presentItem<T extends Row>({ options_json, hidden, ...i }: T) {
  return {
    ...i,
    required: i.required === 1,
    ...(hidden === undefined ? {} : { hidden: hidden === 1 }),
    options: options_json ? (JSON.parse(options_json) as string[]) : null,
    answer: i.kind === "multi" && i.answer ? (JSON.parse(i.answer) as string[]) : i.answer,
  };
}

// the columns the account sees on an item
export const ITEM_COLS = `id, position, label, help, required, status, reject_note, reviewed_at, unavailable_note, kind, options_json, show_if_pos, show_if_value, answer, answer_at,
  NOT ${visible("items")} AS hidden`;
