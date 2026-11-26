import type { Item } from "../src/questions";
import type { Facts } from "../src/taxyear";

// The checklists are written in US English; Canadian readers get these words spelled the Canadian way.
const SPELLING: Record<string, string> = {
  license: "licence",
  licenses: "licences",
  color: "colour",
  Color: "Colour",
  colors: "colours",
  installment: "instalment",
  Installment: "Instalment",
  enrollment: "enrolment",
  "Checks and bank records": "Cheques and bank records",
};

const WORD = new RegExp(`\\b(${Object.keys(SPELLING).join("|")})\\b`, "g");

export const canadian = (s: string) => s.replace(WORD, (w) => SPELLING[w]);

type Template = { id: string; name: string; items: Item[]; facts?: Facts };

export const canadianTemplates = (list: Template[]): Template[] =>
  list.map((t) => ({
    ...t,
    name: canadian(t.name),
    items: t.items.map((i) => ({
      ...i,
      label: canadian(i.label),
      ...(i.help ? { help: canadian(i.help) } : {}),
      ...(i.options ? { options: i.options.map(canadian) } : {}),
      ...(i.show_if ? { show_if: { ...i.show_if, value: canadian(i.show_if.value) } } : {}),
    })),
    ...(t.facts ? { facts: Object.fromEntries(Object.entries(t.facts).map(([year, f]) => [year, Object.fromEntries(Object.entries(f).map(([k, v]) => [k, canadian(v)]))])) } : {}),
  }));
