import type { Lang } from "./lang";
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
  // the wording before a tax year was filled in, so Repeat can fill in the next one
  tpl_json: string | null;
};

// the wording of the companions; relabel() builds the same text in SQL when the document is renamed
const TEXT = {
  en: {
    ask: ["Is ", " in English or French?"],
    certified: "Certified translation of ",
    affidavit: "Translator's affidavit (if the translator is not certified)",
    askHelp: "A document in another language needs a translation. Your answer shows what to upload next.",
    certifiedHelp: "A translation into English or French by a certified translator. The original you uploaded above goes with it.",
    affidavitHelp: "If the translator is not certified, IRCC asks for an affidavit from the translator with the translation. Check IRCC's instructions for your application to see what applies to you.",
  },
  "fr-CA": {
    ask: ["Le document « ", " » est-il en anglais ou en français?"],
    certified: "Traduction certifiée de ",
    affidavit: "Déclaration sous serment du traducteur (si le traducteur n'est pas agréé)",
    askHelp: "Un document dans une autre langue doit être traduit. Votre réponse indique ce qu'il faut téléverser ensuite.",
    certifiedHelp: "Une traduction vers l'anglais ou le français faite par un traducteur agréé. L'original que vous avez téléversé plus haut l'accompagne.",
    affidavitHelp: "Si le traducteur n'est pas agréé, IRCC demande une déclaration sous serment du traducteur avec la traduction. Consultez les instructions d'IRCC pour votre demande afin de savoir ce qui s'applique à vous.",
  },
} as const;

// one item for one person (or for the whole request), with its translation question and companions when it asks for them
export function rowsFor(item: Item & { tpl?: string }, person: Person | null, position: number, showPos: number | null, blueprint: string | null = null, lang: Lang = "en"): Row[] {
  const words = TEXT[lang];
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
    tpl_json: person ? null : (item.tpl ?? null),
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
    tpl_json: null,
    ...over,
  });
  const ask = position + 1;
  return [
    main,
    part(1, "question", words.ask[0] + main.label + words.ask[1], words.askHelp, { kind: "yesno" }),
    part(2, "translation", words.certified + main.label, words.certifiedHelp, { show_if_pos: ask, show_if_value: "no" }),
    part(3, "affidavit", words.affidavit, words.affidavitHelp, { show_if_pos: ask, show_if_value: "no", required: 0 }),
  ];
}

// The rows a template makes for these people, in order, and the template items that wait for people. A condition names an
// item by its place in the template, so it is moved to where the item landed.
export function expandItems(items: (Item & { tpl?: string })[], people: Person[], today: string, lang: Lang = "en"): { rows: Row[]; perPerson: Blueprint[] } {
  const rows: Row[] = [];
  const perPerson: Blueprint[] = [];
  const at = new Map<number, number>();
  items.forEach((item, i) => {
    if (item.per_person) {
      const key = randomId();
      perPerson.push({ ...item, key });
      for (const p of people) if (matches(item.per_person, p, today)) rows.push(...rowsFor(item, p, rows.length, null, key, lang));
    } else {
      at.set(i, rows.length);
      rows.push(...rowsFor(item, null, rows.length, item.show_if ? (at.get(item.show_if.item) ?? null) : null, null, lang));
    }
  });
  return { rows, perPerson };
}

// SQL, run after a person is renamed or a document is: the labels that are made from other labels follow
export function relabel(db: D1Database, firmId: string, requestId: string) {
  const person = "SELECT name FROM people WHERE firm_id = items.firm_id AND request_id = items.request_id AND position = items.person_pos";
  const lang = "SELECT locale FROM requests WHERE firm_id = items.firm_id AND id = items.request_id";
  const { en, "fr-CA": fr } = TEXT;
  const parent = "SELECT label FROM items m WHERE m.firm_id = items.firm_id AND m.request_id = items.request_id AND m.position = items.for_pos";
  return [
    db
      .prepare(`UPDATE items SET label = label_base || '${DASH}' || (${person}) WHERE firm_id = ? AND request_id = ? AND label_base IS NOT NULL AND companion IS NULL AND EXISTS (${person})`)
      .bind(firmId, requestId),
    db
      .prepare(
        `UPDATE items SET label = CASE (${lang}) WHEN 'fr-CA'
           THEN CASE companion WHEN 'question' THEN '${fr.ask[0]}' || (${parent}) || '${fr.ask[1]}' ELSE '${fr.certified}' || (${parent}) END
           ELSE CASE companion WHEN 'question' THEN '${en.ask[0]}' || (${parent}) || '${en.ask[1]}' ELSE '${en.certified}' || (${parent}) END END
         WHERE firm_id = ? AND request_id = ? AND companion IN ('question', 'translation') AND EXISTS (${parent})`,
      )
      .bind(firmId, requestId),
  ];
}
