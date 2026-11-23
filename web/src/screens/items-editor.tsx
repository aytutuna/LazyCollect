import { t } from "../i18n";
import type { Filter, Kind, TemplateItem } from "../types";
import { Check, Field } from "../ui";
import { ExampleField } from "./example-field";

export type EditItem = {
  key: number;
  label: string;
  help: string;
  required: boolean;
  // an uploaded example's id or a standard one's name; empty for none
  example: string;
  kind: Kind;
  // one choice per line
  options: string;
  // the key of the item this one depends on, and the answer that shows it
  showKey: number | null;
  showValue: string;
  // asked once for each person this describes; empty for the whole request
  perPerson: Filter | "";
  // the date asked for, and for an issue date how many months it counts for
  expiry: "" | "expiry" | "issue";
  months: string;
  translation: boolean;
};

// what another item can hang its condition on
export type Parent = { key: number; label: string; kind: Kind; options: string[] };

const KINDS: Kind[] = ["file", "yesno", "text", "longtext", "number", "date", "choice", "multi"];
const CHOICES: Kind[] = ["choice", "multi"];
const FILTERS: Filter[] = ["everyone", "adults", "spouse", "children", "principal"];
const PARENTS: Kind[] = ["yesno", "choice", "multi"];

let keys = 0;

export const newItem = (): EditItem => ({ key: ++keys, label: "", help: "", required: true, example: "", kind: "file", options: "", showKey: null, showValue: "", perPerson: "", expiry: "", months: "6", translation: false });

export function toEditItems(items: TemplateItem[]): EditItem[] {
  const made: EditItem[] = items.map((i) => ({
    key: ++keys,
    label: i.label,
    help: i.help ?? "",
    required: i.required,
    example: i.example ?? "",
    kind: i.kind ?? "file",
    options: (i.options ?? []).join("\n"),
    showKey: null,
    showValue: i.show_if?.value ?? "",
    perPerson: i.per_person ?? "",
    expiry: i.expiry ?? "",
    months: String(i.valid_months ?? 6),
    translation: i.translation ?? false,
  }));
  items.forEach((i, at) => {
    if (i.show_if) made[at].showKey = made[i.show_if.item]?.key ?? null;
  });
  return made;
}

const lines = (options: string) => options.split("\n").map((o) => o.trim()).filter(Boolean);

export function toPayload(items: EditItem[]) {
  return items.map((i) => {
    const at = i.showKey === null ? -1 : items.findIndex((p) => p.key === i.showKey);
    return {
      label: i.label.trim(),
      help: i.help.trim(),
      required: i.required,
      ...(i.example ? { example: i.example } : {}),
      ...(i.kind === "file" ? {} : { kind: i.kind }),
      ...(CHOICES.includes(i.kind) ? { options: lines(i.options) } : {}),
      ...(at >= 0 ? { show_if: { item: at, value: i.showValue } } : {}),
      ...(i.perPerson && at < 0 && !PARENTS.includes(i.kind) ? { per_person: i.perPerson } : {}),
      ...(i.kind === "file" && i.expiry ? { expiry: i.expiry, ...(i.expiry === "issue" ? { valid_months: Number(i.months) || 6 } : {}) } : {}),
      ...(i.kind === "file" && i.translation && at < 0 ? { translation: true } : {}),
    };
  });
}

export const asParent = (i: EditItem): Parent => ({ key: i.key, label: i.label.trim() || t("items.untitled"), kind: i.kind, options: lines(i.options) });

// Earlier items that can be asked about: a yes/no or choice item that is not itself conditional.
export function parentsOf(items: EditItem[], index: number): Parent[] {
  return items.slice(0, index).filter((p) => PARENTS.includes(p.kind) && p.showKey === null && !p.perPerson).map(asParent);
}

const valuesOf = (p: Parent) => (p.kind === "yesno" ? ["yes", "no"] : p.options);

// drops conditions that no longer point at an earlier item with that answer, after a move, a removal or an edit
export function tidy(items: EditItem[]): EditItem[] {
  return items.map((i, at) => {
    if (i.showKey === null) return i;
    const parent = parentsOf(items, at).find((p) => p.key === i.showKey);
    return parent && valuesOf(parent).includes(i.showValue) ? i : { ...i, showKey: null, showValue: "" };
  });
}

type FieldsProps = { item: EditItem; parents: Parent[]; dependedOn: boolean; onChange: (patch: Partial<EditItem>) => void };

// the kind, the choices and the condition of one item; `parents` are what it may depend on
export function QuestionFields({ item, parents, dependedOn, onChange }: FieldsProps) {
  const shown = item.showKey === null ? "" : `${item.showKey}|${item.showValue}`;
  return (
    <>
      <Field label={t("items.kind")}>
        <select value={item.kind} onChange={(e) => onChange({ kind: e.currentTarget.value as Kind })}>
          {KINDS.map((k) => (
            <option value={k}>{t(`kind.${k}`)}</option>
          ))}
        </select>
      </Field>
      {CHOICES.includes(item.kind) && (
        <Field label={t("items.options")} hint={t("items.options_hint")}>
          <textarea required rows={4} value={item.options} onInput={(e) => onChange({ options: e.currentTarget.value })} />
        </Field>
      )}
      {(parents.length > 0 || item.showKey !== null) && (
        <Field label={t("items.show_if")}>
          <select
            value={shown}
            disabled={dependedOn}
            onChange={(e) => {
              const [key, ...value] = e.currentTarget.value.split("|");
              onChange(key ? { showKey: Number(key), showValue: value.join("|") } : { showKey: null, showValue: "" });
            }}
          >
            <option value="">{t("items.show_always")}</option>
            {parents.flatMap((p) =>
              valuesOf(p).map((v) => (
                <option value={`${p.key}|${v}`}>{t("items.condition", { label: p.label, value: p.kind === "yesno" ? t(`items.answer_${v}`) : v })}</option>
              )),
            )}
          </select>
        </Field>
      )}
    </>
  );
}

// who an item is asked of, the date it asks for, and whether it may need a translation
export function TagFields({ item, onChange }: { item: EditItem; onChange: (patch: Partial<EditItem>) => void }) {
  const plain = item.showKey === null;
  return (
    <>
      {plain && !PARENTS.includes(item.kind) && (
        <Field label={t("items.for")}>
          <select value={item.perPerson} onChange={(e) => onChange({ perPerson: e.currentTarget.value as Filter | "" })}>
            <option value="">{t("items.for.none")}</option>
            {FILTERS.map((f) => (
              <option value={f}>{t(`items.for.${f}`)}</option>
            ))}
          </select>
        </Field>
      )}
      {item.kind === "file" && (
        <>
          <Field label={t("items.dates")}>
            <select value={item.expiry} onChange={(e) => onChange({ expiry: e.currentTarget.value as EditItem["expiry"] })}>
              <option value="">{t("items.dates.none")}</option>
              <option value="expiry">{t("items.dates.expiry")}</option>
              <option value="issue">{t("items.dates.issue")}</option>
            </select>
          </Field>
          {item.expiry === "issue" && (
            <Field label={t("items.months")}>
              <input type="number" required min={1} max={120} value={item.months} onInput={(e) => onChange({ months: e.currentTarget.value })} />
            </Field>
          )}
          {plain && <Check label={t("items.translation")} checked={item.translation} onChange={(translation) => onChange({ translation })} />}
        </>
      )}
    </>
  );
}

export function ItemsEditor({ items, onChange }: { items: EditItem[]; onChange: (items: EditItem[]) => void }) {
  const set = (next: EditItem[]) => onChange(tidy(next));
  const change = (key: number, patch: Partial<EditItem>) => set(items.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  function move(index: number, by: number) {
    const next = [...items];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    set(next);
  }

  return (
    <div>
      {items.map((item, index) => (
        <div class="editor-row" key={item.key}>
          <Field label={item.kind === "file" ? t("items.label") : t("items.question")}>
            <input required maxLength={200} value={item.label} onInput={(e) => change(item.key, { label: e.currentTarget.value })} />
          </Field>
          <Field label={t("items.help")}>
            <input maxLength={500} value={item.help} onInput={(e) => change(item.key, { help: e.currentTarget.value })} />
          </Field>
          <ExampleField value={item.example} onChange={(example) => change(item.key, { example })} />
          <QuestionFields item={item} parents={parentsOf(items, index)} dependedOn={items.some((i) => i.showKey === item.key)} onChange={(patch) => change(item.key, patch)} />
          <TagFields item={item} onChange={(patch) => change(item.key, patch)} />
          <Check label={t("items.required")} checked={item.required} onChange={(required) => change(item.key, { required })} />
          <div class="row-actions">
            <button type="button" class="small" disabled={index === 0} onClick={() => move(index, -1)}>
              {t("items.up")}
            </button>
            <button type="button" class="small" disabled={index === items.length - 1} onClick={() => move(index, 1)}>
              {t("items.down")}
            </button>
            <button type="button" class="small quiet" onClick={() => set(items.filter((i) => i.key !== item.key))}>
              {t("items.remove")}
            </button>
          </div>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, newItem()])}>
        {t("items.add")}
      </button>
    </div>
  );
}
