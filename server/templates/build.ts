import type { Item, Kind } from "../src/questions";

type When = string | [string, string];
type Spec = { label: string; help?: string; required: boolean; kind?: Kind; options?: string[]; when?: When; example?: string } & Pick<Item, "per_person" | "expiry" | "valid_months" | "translation">;

export const doc = (label: string, help?: string, when?: When, required = true, example?: string): Spec => ({ label, help, required, when, example });
// adds per-person, date or translation options to an item
export const tag = (spec: Spec, more: Pick<Spec, "per_person" | "expiry" | "valid_months" | "translation">): Spec => ({ ...spec, ...more });
export const ask = (label: string, help?: string, required = true): Spec => ({ label, help, required, kind: "yesno" });
export const text = (label: string, help?: string, when?: When, required = true, kind: Kind = "text"): Spec => ({ label, help, required, kind, when });

// a condition names its parent by label, which is easier to keep right than a position
export function template(id: string, name: string, specs: Spec[]) {
  const items = specs.map(({ when, kind, help, options, example, ...rest }, at): Item => {
    const [parent, value = "yes"]: string[] = typeof when === "string" ? [when] : (when ?? []);
    const item: Item = { ...rest, ...(help ? { help } : {}), ...(kind ? { kind } : {}), ...(options ? { options } : {}), ...(example ? { example } : {}) };
    if (parent === undefined) return item;
    const index = specs.findIndex((s) => s.label === parent);
    if (index < 0 || index >= at) throw new Error(`${id}: "${rest.label}" depends on "${parent}", which is not before it`);
    return { ...item, show_if: { item: index, value } };
  });
  return { id, name, items };
}
