import { useEffect, useState } from "preact/hooks";
import { useLocation, useSearch } from "wouter-preact";
import { get, post, useAction, useLoad } from "../api";
import { fromInput, inDays, toInput } from "../format";
import { LOCALES, isLocale, locale, t, type Locale } from "../i18n";
import type { Client, RequestDetail, Template } from "../types";
import { ErrorNote, Field, Loading } from "../ui";
import { ClientForm } from "./clients";
import { ItemsEditor, newItem, toEditItems, toPayload, type EditItem } from "./items-editor";
import { followLanguage } from "./template-language";
import { PeopleDrafts, newDraft, toPeople, type Draft } from "./people";

export function NewRequest() {
  const [, go] = useLocation();
  const preset = new URLSearchParams(useSearch()).get("template") ?? "";
  const clients = useLoad(() => get<Client[]>("/clients"));
  const [lang, setLang] = useState<Locale>(locale());
  const templates = useLoad(() => get<Template[]>(`/templates?locale=${lang}`), [lang]);
  const [clientId, setClientId] = useState("");
  const [addingClient, setAddingClient] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [items, setItems] = useState<EditItem[]>([newItem()]);
  const [title, setTitle] = useState("");
  // the title the template gave, and whether the items have been changed since: neither follows a language change once the person has taken over
  const [templateTitle, setTemplateTitle] = useState("");
  const [itemsEdited, setItemsEdited] = useState(false);
  const [note, setNote] = useState("");
  const [deadline, setDeadline] = useState(toInput(inDays(14)));
  const [people, setPeople] = useState<Draft[]>([]);
  const [validUntil, setValidUntil] = useState("");
  const [taxYear, setTaxYear] = useState<number | null>(null);
  const { busy, error, run } = useAction();

  function pickTemplate(id: string) {
    setTemplateId(id);
    setItemsEdited(false);
    const found = templates.data?.find((x) => x.id === id);
    if (!found) {
      setItems([newItem()]);
      return;
    }
    setItems(toEditItems(found.items));
    setTaxYear(found.tax?.suggested ?? null);
    const named = found.tax ? `${found.name} ${found.tax.suggested}` : found.name;
    if (!title) {
      setTitle(named);
      setTemplateTitle(named);
    }
    // a checklist for each person starts with the client as the principal applicant
    if (found.items.some((i) => i.per_person) && people.length === 0) setPeople([newDraft("principal", clients.data?.find((c) => c.id === clientId)?.name ?? "")]);
  }

  useEffect(() => {
    if (preset && templates.data && !templateId) pickTemplate(preset);
  }, [templates.data]);

  // a request starts in its client's language
  function pickClient(id: string) {
    setClientId(id);
    const l = clients.data?.find((c) => c.id === id)?.locale;
    if (isLocale(l)) setLang(l);
  }

  // a built-in checklist already chosen follows a change of language; one that was edited or is the firm's own stays as it is
  useEffect(() => {
    const found = templates.data?.find((x) => x.id === templateId);
    const follow = followLanguage(found?.builtin ? found : undefined, itemsEdited, title, templateTitle);
    if (follow.items) setItems(toEditItems(found!.items));
    if (follow.title !== null) {
      setTitle(follow.title);
      setTemplateTitle(follow.title);
    }
  }, [templates.data]);

  async function submit(e: Event) {
    e.preventDefault();
    await run(async () => {
      const created = await post<RequestDetail>("/requests", {
        client_id: clientId,
        title,
        note,
        deadline: fromInput(deadline),
        locale: lang,
        items: toPayload(items),
        people: toPeople(people),
        ...(templateId ? { template_ref: templateId } : {}),
        ...(taxYear !== null || typed ? { tax_year: taxYear ?? new Date().getFullYear() - 1 } : {}),
        ...(validUntil ? { valid_until: validUntil } : {}),
      });
      go(`/requests/${created.id}`);
    });
  }

  if (!clients.data || !templates.data) return clients.error || templates.error ? <ErrorNote error={clients.error ?? templates.error} /> : <Loading />;

  const builtin = templates.data.filter((x) => x.builtin);
  const own = templates.data.filter((x) => !x.builtin);
  const chosen = templates.data.find((x) => x.id === templateId);
  // a year marker typed into the checklist needs a tax year too, even without a template
  const typed = items.some((i) => /\{year(?:[+-]\d{1,2})?\}/.test(`${i.label} ${i.help}`));
  const taxInfo = chosen?.tax ?? (typed ? { years: Array.from({ length: 7 }, (_, i) => new Date().getFullYear() - 5 + i), suggested: new Date().getFullYear() - 1 } : null);

  // the year in a title that still has the suggested one follows the choice
  function changeYear(year: number) {
    if (taxYear !== null) setTitle((cur) => cur.replace(String(taxYear), String(year)));
    setTaxYear(year);
  }

  return (
    <>
      <h1>{t("new.title")}</h1>
      <section>
        <h2>{t("new.client")}</h2>
        {clients.data.length > 0 && (
          <Field label={t("new.pick_client")}>
            <select value={clientId} onChange={(e) => pickClient(e.currentTarget.value)}>
              <option value="">{t("new.choose")}</option>
              {clients.data.map((c) => (
                <option value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        )}
        {addingClient ? (
          <ClientForm
            onSaved={(c) => {
              clients.reload();
              pickClient(c.id);
              setAddingClient(false);
            }}
            onCancel={() => setAddingClient(false)}
          />
        ) : (
          <button type="button" onClick={() => setAddingClient(true)}>
            {t("new.add_client")}
          </button>
        )}
        {clients.data.length === 0 && !addingClient && <p class="muted">{t("new.no_clients")}</p>}
      </section>

      <form onSubmit={submit}>
        <section>
          <h2>{t("new.details")}</h2>
          <Field label={t("new.title_field")}>
            <input required maxLength={200} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
          </Field>
          <Field label={t("new.note")} hint={t("new.note_hint")}>
            <textarea rows={3} maxLength={2000} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
          </Field>
          <Field label={t("new.language")} hint={t("new.language_hint")}>
            <select value={lang} onChange={(e) => setLang(e.currentTarget.value as Locale)}>
              {LOCALES.map((l) => (
                <option value={l} lang={l}>
                  {t(`lang.${l}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("new.deadline")}>
            <input type="date" required min={toInput(Date.now())} max={toInput(inDays(729))} value={deadline} onInput={(e) => setDeadline(e.currentTarget.value)} />
          </Field>
        </section>

        <section>
          <h2>{t("people.title")}</h2>
          <p class="muted">{t("people.new_hint")}</p>
          <PeopleDrafts drafts={people} onChange={setPeople} />
          {toPeople(people).length === 0 && items.some((i) => i.perPerson) && <p class="muted">{t("people.new_waiting")}</p>}
        </section>

        <section>
          <h2>{t("new.checklist")}</h2>
          <Field label={t("new.template")}>
            <select value={templateId} onChange={(e) => pickTemplate(e.currentTarget.value)}>
              <option value="">{t("new.blank")}</option>
              {own.length > 0 && (
                <optgroup label={t("templates.mine")}>
                  {own.map((x) => (
                    <option value={x.id}>{x.name}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label={t("templates.builtin")}>
                {builtin.map((x) => (
                  <option value={x.id}>{x.name}</option>
                ))}
              </optgroup>
            </select>
          </Field>
          {taxInfo && (
            <Field label={t("new.tax_year")} hint={t("new.tax_year_hint")}>
              <select value={taxYear ?? taxInfo.suggested} onChange={(e) => changeYear(Number(e.currentTarget.value))}>
                {taxInfo.years.map((y) => (
                  <option value={y}>{y}</option>
                ))}
              </select>
            </Field>
          )}
          {items.some((i) => i.expiry) && (
            <Field label={t("detail.valid_until")} hint={t("detail.valid_until_hint")}>
              <input type="date" min="1900-01-01" max="2100-12-31" value={validUntil} onInput={(e) => setValidUntil(e.currentTarget.value)} />
            </Field>
          )}
          <ItemsEditor
            items={items}
            onChange={(next) => {
              setItems(next);
              setItemsEdited(true);
            }}
          />
        </section>

        <ErrorNote error={error} />
        <button class="primary" disabled={busy || addingClient || !clientId || items.length === 0}>
          {t("new.save")}
        </button>
        {items.length === 0 && <p class="muted">{t("new.need_item")}</p>}
      </form>
    </>
  );
}
