import { t } from "../i18n";
import type { TemplateItem } from "../types";
import { Check, Field } from "../ui";

export type EditItem = { key: number; label: string; help: string; required: boolean };

let keys = 0;

export const newItem = (): EditItem => ({ key: ++keys, label: "", help: "", required: true });

export const toEditItems = (items: TemplateItem[]): EditItem[] =>
  items.map((i) => ({ key: ++keys, label: i.label, help: i.help ?? "", required: i.required }));

export const toPayload = (items: EditItem[]) => items.map((i) => ({ label: i.label.trim(), help: i.help.trim(), required: i.required }));

export function ItemsEditor({ items, onChange }: { items: EditItem[]; onChange: (items: EditItem[]) => void }) {
  const change = (key: number, patch: Partial<EditItem>) => onChange(items.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  function move(index: number, by: number) {
    const next = [...items];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    onChange(next);
  }

  return (
    <div>
      {items.map((item, index) => (
        <div class="editor-row" key={item.key}>
          <Field label={t("items.label")}>
            <input required maxLength={200} value={item.label} onInput={(e) => change(item.key, { label: e.currentTarget.value })} />
          </Field>
          <Field label={t("items.help")}>
            <input maxLength={500} value={item.help} onInput={(e) => change(item.key, { help: e.currentTarget.value })} />
          </Field>
          <Check label={t("items.required")} checked={item.required} onChange={(required) => change(item.key, { required })} />
          <div class="row-actions">
            <button type="button" class="small" disabled={index === 0} onClick={() => move(index, -1)}>
              {t("items.up")}
            </button>
            <button type="button" class="small" disabled={index === items.length - 1} onClick={() => move(index, 1)}>
              {t("items.down")}
            </button>
            <button type="button" class="small quiet" onClick={() => onChange(items.filter((i) => i.key !== item.key))}>
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
