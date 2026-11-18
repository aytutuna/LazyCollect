import { useState } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import { del, get, patch, post, useAction, useLoad } from "../api";
import { t } from "../i18n";
import type { Template } from "../types";
import { Confirm, ErrorNote, Field, Loading } from "../ui";
import { ItemsEditor, newItem, toEditItems, toPayload, type EditItem } from "./items-editor";

export function Templates() {
  const [, go] = useLocation();
  const { data, error, reload } = useLoad(() => get<Template[]>("/templates"));
  const [asking, setAsking] = useState<Template | null>(null);
  const act = useAction();

  async function copy(tpl: Template) {
    await act.run(async () => {
      const made = await post<Template>("/templates", { name: t("templates.copy_name", { name: tpl.name }), items: tpl.items });
      go(`/templates/${made.id}`);
    });
  }

  async function remove() {
    if (asking && (await act.run(() => del(`/templates/${asking.id}`)))) {
      setAsking(null);
      reload();
    }
  }

  if (!data) return error ? <ErrorNote error={error} /> : <Loading />;

  const group = (title: string, list: Template[], empty?: string) => (
    <section>
      <h2>{title}</h2>
      {list.length === 0 && empty && <p class="muted">{empty}</p>}
      <ul class="items">
        {list.map((tpl) => (
          <li key={tpl.id}>
            <div class="main">
              <strong>{tpl.name}</strong>
              <details>
                <summary>{t("templates.items", { n: tpl.items.length })}</summary>
                <ul>
                  {tpl.items.map((i) => (
                    <li>{i.label}</li>
                  ))}
                </ul>
              </details>
            </div>
            <div class="side">
              <Link href={`/new?template=${tpl.id}`} class="button small primary">
                {t("templates.use")}
              </Link>
              {tpl.builtin ? (
                <button class="small" disabled={act.busy} onClick={() => copy(tpl)}>
                  {t("templates.copy")}
                </button>
              ) : (
                <>
                  <Link href={`/templates/${tpl.id}`} class="button small">
                    {t("edit")}
                  </Link>
                  <button class="small quiet" onClick={() => setAsking(tpl)}>
                    {t("delete")}
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <>
      <div class="head">
        <h1>{t("templates.title")}</h1>
        <Link href="/templates/new" class="button primary">
          {t("templates.new")}
        </Link>
      </div>
      {!asking && <ErrorNote error={act.error} />}
      {group(t("templates.mine"), data.filter((x) => !x.builtin), t("templates.none"))}
      {group(t("templates.builtin"), data.filter((x) => x.builtin))}
      {asking && (
        <Confirm
          title={t("templates.delete_title", { name: asking.name })}
          body={t("templates.delete_body")}
          confirm={t("templates.delete")}
          danger
          busy={act.busy}
          error={act.error}
          onConfirm={remove}
          onCancel={() => setAsking(null)}
        />
      )}
    </>
  );
}

export function TemplatePage({ id }: { id?: string }) {
  const { data, error } = useLoad(() => (id ? get<Template[]>("/templates") : Promise.resolve([])), [id]);
  if (!data) return error ? <ErrorNote error={error} /> : <Loading />;
  const tpl = id ? data.find((x) => x.id === id && !x.builtin) : undefined;
  if (id && !tpl) return <p>{t("notfound")}</p>;
  return <TemplateForm template={tpl} />;
}

function TemplateForm({ template }: { template?: Template }) {
  const [, go] = useLocation();
  const [name, setName] = useState(template?.name ?? "");
  const [items, setItems] = useState<EditItem[]>(template ? toEditItems(template.items) : [newItem()]);
  const { busy, error, run } = useAction();

  async function submit(e: Event) {
    e.preventDefault();
    const body = { name, items: toPayload(items) };
    const call = template ? () => patch(`/templates/${template.id}`, body) : () => post("/templates", body);
    if (await run(call)) go("/templates");
  }

  return (
    <>
      <h1>{template ? t("templates.edit") : t("templates.new")}</h1>
      <form onSubmit={submit}>
        <section>
          <Field label={t("templates.name")}>
            <input required maxLength={120} value={name} onInput={(e) => setName(e.currentTarget.value)} />
          </Field>
          <h2>{t("new.checklist")}</h2>
          <ItemsEditor items={items} onChange={setItems} />
        </section>
        <ErrorNote error={error} />
        {items.length === 0 && <p class="muted">{t("new.need_item")}</p>}
        <div class="actions">
          <button class="primary" disabled={busy || items.length === 0}>
            {t("save")}
          </button>
          <Link href="/templates" class="button">
            {t("cancel")}
          </Link>
        </div>
      </form>
    </>
  );
}
