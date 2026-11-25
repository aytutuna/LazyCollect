import { useState } from "preact/hooks";
import { Link, useLocation, useSearch } from "wouter-preact";
import { get, post, useAction, useLoad } from "../api";
import { fromInput, inDays, toInput, toLocalInput } from "../format";
import { t } from "../i18n";
import { usePaged, useSearchBox } from "../paged";
import { MAX_SELECT, carried, collect, useSelection } from "../selection";
import type { Batch, ClientRow, Me, RequestRow, Template } from "../types";
import { Check, Confirm, ErrorNote, Field, Loading } from "../ui";

const DAILY = { trial: 50, paid: 500 };

const mailable = (c: ClientRow) => Boolean(c.email && c.email_ok_at && !c.email_stop_at);

function ClientPicker({ picked }: { picked: ReturnType<typeof useSelection<ClientRow>> }) {
  const [q, setQ] = useState("");
  const [typed, type] = useSearchBox(q, setQ);
  const query = q ? `q=${encodeURIComponent(q)}` : "";
  const list = usePaged<ClientRow>("/clients/search", query);
  const everyone = useAction();
  const [truncated, setTruncated] = useState(false);
  const allOnPage = list.rows.length > 0 && list.rows.every((c) => picked.has(c.id));

  async function selectMatching() {
    await everyone.run(async () => {
      const all = await collect<ClientRow>("/clients/search", query);
      picked.add(all);
      setTruncated(all.length >= MAX_SELECT);
    });
  }

  return (
    <>
      <div class="filters">
        <Field label={t("batch.search")}>
          <input type="search" value={typed} maxLength={100} onInput={(e) => type(e.currentTarget.value)} />
        </Field>
      </div>
      <div class="row-actions">
        <button type="button" class="small" disabled={everyone.busy} onClick={selectMatching}>
          {t("clients.select_matching")}
        </button>
        {picked.map.size > 0 && (
          <button type="button" class="small quiet" onClick={picked.clear}>
            {t("clients.clear_selection")}
          </button>
        )}
      </div>
      {truncated && <p class="muted">{t("clients.select_limit")}</p>}
      <ErrorNote error={everyone.error} />
      <ErrorNote error={list.error} />
      {list.rows.length > 0 && (
        <div aria-busy={list.loading}>
          <table class={`stack${list.loading ? " busy" : ""}`}>
            <thead>
              <tr>
                <th class="pick">
                  <input
                    type="checkbox"
                    aria-label={t("clients.select_page")}
                    checked={allOnPage}
                    onChange={(e) => (e.currentTarget.checked ? picked.add(list.rows) : picked.remove(list.rows.map((c) => c.id)))}
                  />
                </th>
                <th>{t("clients.name")}</th>
                <th>{t("clients.email")}</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((c) => (
                <tr key={c.id}>
                  <td class="pick">
                    <input type="checkbox" aria-label={t("clients.select_one", { name: c.name })} checked={picked.has(c.id)} onChange={() => picked.toggle(c)} />
                  </td>
                  <td class="name">{c.name}</td>
                  <td>{c.email ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.next !== null && (
            <button type="button" disabled={list.more.busy} onClick={list.loadMore}>
              {list.more.busy ? t("loading") : t("more")}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function RequestPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [typed, type] = useSearchBox(q, setQ);
  const list = usePaged<RequestRow>("/requests", new URLSearchParams({ view: "all", sort: "newest", ...(q && { q }) }).toString());
  return (
    <>
      <Field label={t("batch.search_request")}>
        <input type="search" value={typed} maxLength={100} onInput={(e) => type(e.currentTarget.value)} />
      </Field>
      <Field label={t("batch.pick_request")}>
        <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
          <option value="">{t("batch.choose")}</option>
          {list.rows.map((r) => (
            <option value={r.id}>{`${r.title} (${r.client_name})`}</option>
          ))}
        </select>
      </Field>
    </>
  );
}

export function NewBatch() {
  const [, go] = useLocation();
  const repeat = new URLSearchParams(useSearch()).get("repeat") === "1";
  const me = useLoad(() => get<Me>("/me"));
  const templates = useLoad(() => get<Template[]>("/templates"));
  const clients = useSelection<ClientRow>(repeat ? new Map() : carried.clients);
  const [source, setSource] = useState<"template" | "request">("template");
  const [templateId, setTemplateId] = useState("");
  const [requestId, setRequestId] = useState("");
  const [taxYear, setTaxYear] = useState<number | null>(null);
  const [title, setTitle] = useState(repeat ? t("batch.repeat_default") : "");
  const [deadline, setDeadline] = useState(toInput(inDays(30)));
  const [reminders, setReminders] = useState(true);
  const [later, setLater] = useState(false);
  const [sendAt, setSendAt] = useState(toLocalInput(Date.now() + 3_600_000));
  const [asking, setAsking] = useState(false);
  const { busy, error, run } = useAction();

  if (!me.data || !templates.data) return me.error || templates.error ? <ErrorNote error={me.error ?? templates.error} /> : <Loading />;

  const requests = [...carried.requests.values()];
  const count = repeat ? requests.length : clients.map.size;
  const unreachable = [...clients.map.values()].filter((c) => !mailable(c)).length;
  const cap = me.data.firm.subscribed ? DAILY.paid : DAILY.trial;
  const emails = repeat ? requests.length : count - unreachable;
  const days = Math.ceil(emails / cap);
  const ready = count > 0 && Boolean(title.trim()) && (repeat || (source === "template" ? templateId : requestId)) && (!later || sendAt);
  const own = templates.data.filter((x) => !x.builtin);
  const builtin = templates.data.filter((x) => x.builtin);
  const chosen = templates.data.find((x) => x.id === templateId);

  async function create() {
    const body: Record<string, unknown> = { title, reminders_on: reminders, send_at: later ? sendAt : null };
    if (repeat) body.request_ids = requests.map((r) => r.id);
    else {
      body.client_ids = [...clients.map.keys()];
      body.deadline = fromInput(deadline);
      if (source === "template") {
        body.template_id = templateId;
        if (chosen?.tax) body.tax_year = taxYear ?? chosen.tax.suggested;
      }
      else body.request_id = requestId;
    }
    const made = await run(async () => {
      const batch = await post<Batch>("/batches", body);
      carried.clients = new Map();
      carried.requests = new Map();
      go(`/batches/${batch.id}`);
    });
    if (made) setAsking(false);
  }

  function submit(e: Event) {
    e.preventDefault();
    setAsking(true);
  }

  return (
    <>
      <p>
        <Link href="/batches">{t("batch.all_batches")}</Link>
      </p>
      <h1>{repeat ? t("batch.repeat_title") : t("batch.form.title")}</h1>
      <form onSubmit={submit}>
        {repeat ? (
          <section>
            {requests.length === 0 ? (
              <p class="muted">
                {t("batch.repeat_none")} <Link href="/">{t("nav.requests")}</Link>
              </p>
            ) : (
              <p>{t("batch.repeat_intro", { n: requests.length })}</p>
            )}
          </section>
        ) : (
          <section>
            <h2>{t("batch.clients")}</h2>
            <p role="status">{count > 0 ? t("clients.selected", { n: count }) : t("batch.clients_none")}</p>
            {unreachable > 0 && <p class="muted">{t("batch.no_email_note", { n: unreachable })}</p>}
            <ClientPicker picked={clients} />
          </section>
        )}

        {!repeat && (
          <section>
            <h2>{t("batch.source")}</h2>
            <div class="chips" role="group" aria-label={t("batch.source")}>
              <button type="button" class="chip" aria-pressed={source === "template"} onClick={() => setSource("template")}>
                {t("batch.source_template")}
              </button>
              <button type="button" class="chip" aria-pressed={source === "request"} onClick={() => setSource("request")}>
                {t("batch.source_request")}
              </button>
            </div>
            {source === "template" ? (
              <Field label={t("batch.pick_template")}>
                <select
                  value={templateId}
                  onChange={(e) => {
                    setTemplateId(e.currentTarget.value);
                    setTaxYear(templates.data?.find((x) => x.id === e.currentTarget.value)?.tax?.suggested ?? null);
                  }}
                >
                  <option value="">{t("batch.choose")}</option>
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
                {templates.data.find((x) => x.id === templateId)?.items.some((i) => i.per_person) && <span class="hint">{t("batch.person_items")}</span>}
              </Field>
            ) : (
              <RequestPicker value={requestId} onChange={setRequestId} />
            )}
            {source === "template" && chosen?.tax && (
              <Field label={t("new.tax_year")} hint={t("batch.tax_year_hint")}>
                <select value={taxYear ?? chosen.tax.suggested} onChange={(e) => setTaxYear(Number(e.currentTarget.value))}>
                  {chosen.tax.years.map((y) => (
                    <option value={y}>{y}</option>
                  ))}
                </select>
              </Field>
            )}
          </section>
        )}

        <section>
          <h2>{t("new.details")}</h2>
          <Field label={repeat ? t("batch.repeat_label") : t("batch.title_field")} hint={repeat ? undefined : t("batch.title_hint")}>
            <input required maxLength={200} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
          </Field>
          {!repeat && (
            <Field label={t("batch.deadline")}>
              <input type="date" required min={toInput(Date.now())} max={toInput(inDays(729))} value={deadline} onInput={(e) => setDeadline(e.currentTarget.value)} />
            </Field>
          )}
          <Check label={t("batch.reminders")} checked={reminders} onChange={setReminders} />
        </section>

        <section>
          <h2>{t("batch.when")}</h2>
          <div class="chips" role="group" aria-label={t("batch.when")}>
            <button type="button" class="chip" aria-pressed={!later} onClick={() => setLater(false)}>
              {t("batch.when_now")}
            </button>
            <button type="button" class="chip" aria-pressed={later} onClick={() => setLater(true)}>
              {t("batch.when_later")}
            </button>
          </div>
          {later && (
            <Field label={t("batch.when_at", { tz: me.data.firm.tz })}>
              <input type="datetime-local" required min={toLocalInput(Date.now())} value={sendAt} onInput={(e) => setSendAt(e.currentTarget.value)} />
            </Field>
          )}
          <p class="muted">{t("batch.hours_note")}</p>
          <p class="muted">{t(me.data.firm.subscribed ? "batch.limit_paid" : "batch.limit_trial")}</p>
          {days > 1 && <p class="muted">{t("batch.days", { n: days })}</p>}
        </section>

        <ErrorNote error={error} />
        <button class="primary" disabled={busy || !ready}>
          {later ? t("batch.submit_later") : t("batch.submit_now")}
        </button>
      </form>
      {asking && (
        <Confirm
          title={t("batch.confirm_title", { n: count })}
          body={t("batch.confirm_body")}
          confirm={later ? t("batch.submit_later") : t("batch.submit_now")}
          busy={busy}
          error={error}
          onConfirm={create}
          onCancel={() => setAsking(false)}
        />
      )}
    </>
  );
}
