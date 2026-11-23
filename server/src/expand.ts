import { parseDay, type Item } from "./questions";
import { randomId } from "./util";
import { text } from "./validate";

export const ROLES = ["principal", "spouse", "child", "other"] as const;
export type Role = (typeof ROLES)[number];
export type Person = { position: number; role: Role; name: string; dob: string | null };

// a template item that waits for people; the key ties the items made from it to it
export type Blueprint = Item & { key?: string };

export const MAX_PEOPLE = 12;
// a request's items once people and translation companions are counted
export const MAX_ITEMS = 300;

const DASH = " — ";

export function parsePerson(v: unknown): Omit<Person, "position"> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const role = ROLES.find((r) => r === o.role);
  const name = text(o.name, 100);
  const dob = parseDay(o.dob ?? null);
  return role && name && dob !== undefined ? { role, name, dob } : undefined;
}

export function parsePeople(v: unknown): Person[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_PEOPLE) return undefined;
  const people = v.map(parsePerson);
  return people.every((p) => p) ? people.map((p, position) => ({ ...p!, position })) : undefined;
}

const adult = (p: Person, today: string) => {
  if (!p.dob) return p.role !== "child";
  const years = Number(today.slice(0, 4)) - Number(p.dob.slice(0, 4)) - (today.slice(5) < p.dob.slice(5) ? 1 : 0);
  return years >= 18;
};

export function matches(filter: NonNullable<Item["per_person"]>, p: Person, today: string): boolean {
  switch (filter) {
    case "everyone":
      return true;
    case "adults":
      return adult(p, today);
    case "spouse":
      return p.role === "spouse";
    case "children":
      return p.role === "child";
    case "principal":
      return p.role === "principal";
  }
}

// the item's own wording once its person's name is taken off the end
export const withoutPerson = (label: string, name: string | null) => (name && label.endsWith(DASH + name) ? label.slice(0, -(DASH + name).length) : label);

// the wording a reminder uses: "Passport (Amira Haddad)"
export const asked = (label: string, name: string | null) => (name && label.endsWith(DASH + name) ? `${withoutPerson(label, name)} (${name})` : label);

// an item as the table holds it; the positions are those of the request it goes into
export type Row = {
  position: number;
  label: string;
  help: string | null;
  required: number;
  kind: string;
  options_json: string | null;
  show_if_pos: number | null;
  show_if_value: string | null;
  example: string | null;
  person_pos: number | null;
  label_base: string | null;
  for_pos: number | null;
  companion: "question" | "translation" | "affidavit" | null;
  translation: number;
  expiry_rule: string | null;
  valid_months: number | null;
  blueprint: string | null;
};

// the wording of the companions; relabel() builds the same text in SQL when the document is renamed
const ASK = ["Is ", " in English or French?"] as const;
const CERTIFIED = "Certified translation of ";
const AFFIDAVIT = "Translator's affidavit (if the translator is not certified)";
const ASK_HELP = "A document in another language needs a translation. Your answer shows what to upload next.";
const CERTIFIED_HELP = "A translation into English or French by a certified translator. The original you uploaded above goes with it.";
const AFFIDAVIT_HELP = "If the translator is not certified, IRCC asks for an affidavit from the translator with the translation. Check IRCC's instructions for your application to see what applies to you.";

// one item for one person (or for the whole request), with its translation question and companions when it asks for them
export function rowsFor(item: Item, person: Person | null, position: number, showPos: number | null, blueprint: string | null = null): Row[] {
  const main: Row = {
    position,
    label: person ? item.label + DASH + person.name : item.label,
    help: item.help ?? null,
    required: item.required ? 1 : 0,
    kind: item.kind ?? "file",
    options_json: item.options ? JSON.stringify(item.options) : null,
    show_if_pos: showPos,
    show_if_value: item.show_if?.value ?? null,
    example: item.example ?? null,
    person_pos: person?.position ?? null,
    label_base: person ? item.label : null,
    for_pos: null,
    companion: null,
    translation: item.translation ? 1 : 0,
    expiry_rule: item.expiry ?? null,
    valid_months: item.valid_months ?? null,
    blueprint: person ? blueprint : null,
  };
  if (!item.translation) return [main];
  const part = (offset: number, companion: NonNullable<Row["companion"]>, label: string, help: string, over: Partial<Row>): Row => ({
    ...main,
    position: position + offset,
    label,
    help,
    kind: "file",
    options_json: null,
    show_if_pos: null,
    show_if_value: null,
    example: null,
    label_base: null,
    for_pos: position,
    companion,
    translation: 0,
    expiry_rule: null,
    valid_months: null,
    blueprint: null,
    ...over,
  });
  const ask = position + 1;
  return [
    main,
    part(1, "question", ASK[0] + main.label + ASK[1], ASK_HELP, { kind: "yesno" }),
    part(2, "translation", CERTIFIED + main.label, CERTIFIED_HELP, { show_if_pos: ask, show_if_value: "no" }),
    part(3, "affidavit", AFFIDAVIT, AFFIDAVIT_HELP, { show_if_pos: ask, show_if_value: "no", required: 0 }),
  ];
}

// The rows a template makes for these people, in order, and the template items that wait for people. A condition names an
// item by its place in the template, so it is moved to where the item landed.
export function expandItems(items: Item[], people: Person[], today: string): { rows: Row[]; perPerson: Blueprint[] } {
  const rows: Row[] = [];
  const perPerson: Blueprint[] = [];
  const at = new Map<number, number>();
  items.forEach((item, i) => {
    if (item.per_person) {
      const key = randomId();
      perPerson.push({ ...item, key });
      for (const p of people) if (matches(item.per_person, p, today)) rows.push(...rowsFor(item, p, rows.length, null, key));
    } else {
      at.set(i, rows.length);
      rows.push(...rowsFor(item, null, rows.length, item.show_if ? (at.get(item.show_if.item) ?? null) : null));
    }
  });
  return { rows, perPerson };
}

// SQL, run after a person is renamed or a document is: the labels that are made from other labels follow
export function relabel(db: D1Database, firmId: string, requestId: string) {
  const person = "SELECT name FROM people WHERE firm_id = items.firm_id AND request_id = items.request_id AND position = items.person_pos";
  const parent = "SELECT label FROM items m WHERE m.firm_id = items.firm_id AND m.request_id = items.request_id AND m.position = items.for_pos";
  return [
    db
      .prepare(`UPDATE items SET label = label_base || '${DASH}' || (${person}) WHERE firm_id = ? AND request_id = ? AND label_base IS NOT NULL AND companion IS NULL AND EXISTS (${person})`)
      .bind(firmId, requestId),
    db
      .prepare(
        `UPDATE items SET label = CASE companion WHEN 'question' THEN '${ASK[0]}' || (${parent}) || '${ASK[1]}' ELSE '${CERTIFIED}' || (${parent}) END
         WHERE firm_id = ? AND request_id = ? AND companion IN ('question', 'translation') AND EXISTS (${parent})`,
      )
      .bind(firmId, requestId),
  ];
}
