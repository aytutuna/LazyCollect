import { useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { del, get, patch, post, useAction, useLoad } from "../api";
import { fmtDate, fromInput, inDays, isLate, relative, toInput } from "../format";
import { t } from "../i18n";
import type { Client, Item, RequestDetail } from "../types";
import { Badge, Check, Confirm, ErrorNote, Field, Loading, statusLabel, statusTone } from "../ui";

const ITEM_TONES = { empty: "grey", submitted: "teal", approved: "green", rejected: "red" };

type Ask = "link" | "close" | "delete" | null;

export function RequestPage({ id }: { id: string }) {
  const [, go] = useLocation();
  const { data: req, error, reload } = useLoad(() => get<RequestDetail>(`/requests/${id}`), [id]);
  const clients = useLoad(() => get<Client[]>("/clients"));
  const [editing, setEditing] = useState(false);
  const [manage, setManage] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const act = useAction();

  if (!req) return error ? <ErrorNote error={error} /> : <Loading />;

  const editable = req.status === "draft" || req.status === "open";
  const clientName = clients.data?.find((c) => c.id === req.client_id)?.name ?? "";
  const received = req.items.filter((i) => i.status === "submitted" || i.status === "approved").length;
  const late = isLate(req.deadline) && editable;

  async function makeLink() {
    const done = await act.run(async () => {
      setUrl((await post<{ url: string }>(`/requests/${id}/link`)).url);
      setCopied(false);
      reload();
    });
    if (done) setAsk(null);
  }

  async function close() {
    if (await act.run(() => post(`/requests/${id}/close`))) {
      setAsk(null);
      setUrl(null);
      reload();
    }
  }

  async function remove() {
    if (await act.run(() => del(`/requests/${id}`))) go("/");
  }

  async function copy() {
    await navigator.clipboard.writeText(url!).then(() => setCopied(true), () => {});
  }

  async function removeItem(item: Item) {
    if (await act.run(() => del(`/requests/${id}/items/${item.id}`))) reload();
  }

  const saved = () => {
    setEditing(false);
    setAdding(false);
    setEditingItem(null);
    reload();
  };

  return (
    <>
      <div class="head">
        <h1>{req.title}</h1>
        <Badge tone={statusTone(req.status)}>{statusLabel(req.status)}</Badge>
      </div>

      {!ask && <ErrorNote error={act.error} />}

      <section>
        {editing ? (
          <DetailsForm req={req} onSaved={saved} onCancel={() => setEditing(false)} />
        ) : (
          <>
            <dl class="facts">
              <dt>{t("requests.client")}</dt>
              <dd>{clientName}</dd>
              <dt>{t("requests.deadline")}</dt>
              <dd>
                <span class={late ? "late" : ""}>{relative(req.deadline)}</span>, {fmtDate(req.deadline)}
              </dd>
              <dt>{t("requests.progress")}</dt>
              <dd>{t("progress", { done: received, total: req.items.length })}</dd>
              {req.note && (
                <>
                  <dt>{t("new.note")}</dt>
                  <dd>{req.note}</dd>
                </>
              )}
            </dl>
            {editable && <button onClick={() => setEditing(true)}>{t("detail.edit")}</button>}
          </>
        )}
      </section>

      {editable && (
        <section>
          <h2>{t("detail.link")}</h2>
          {url ? (
            <>
              <p>{t("detail.link_once")}</p>
              <div class="linkbox">
                <input readOnly aria-label={t("detail.link")} value={url} onFocus={(e) => e.currentTarget.select()} />
                <button class="primary" onClick={copy}>
                  {copied ? t("detail.copied") : t("detail.copy")}
                </button>
              </div>
              <p class="muted">{t("detail.email_soon")}</p>
            </>
          ) : (
            <p class="muted">{req.sent_at ? t("detail.link_exists") : t("detail.link_none")}</p>
          )}
          <button class={url || req.sent_at ? "" : "primary"} disabled={act.busy || req.items.length === 0} onClick={() => (req.sent_at ? setAsk("link") : makeLink())}>
            {req.sent_at ? t("detail.new_link") : t("detail.create_link")}
          </button>
        </section>
      )}

      <section>
        <div class="head">
          <h2>{t("detail.items")}</h2>
          {editable && (
            <button class="small" aria-pressed={manage} onClick={() => setManage(!manage)}>
              {manage ? t("detail.done_editing") : t("detail.edit_items")}
            </button>
          )}
        </div>
        <ul class="items">
          {req.items.map((item) => (
            <li key={item.id}>
              <div class="main">
                {editingItem === item.id ? (
                  <ItemForm requestId={id} item={item} onSaved={saved} onCancel={() => setEditingItem(null)} />
                ) : (
                  <>
                    <div class="line">
                      <span>
                        <strong>{item.label}</strong> {!item.required && <span class="muted">({t("items.optional")})</span>}
                      </span>
                      <Badge tone={ITEM_TONES[item.status]}>{t(`item.${item.status}`)}</Badge>
                    </div>
                    {item.help && <div class="muted">{item.help}</div>}
                    {item.status === "rejected" && item.reject_note && <p class="reject">{item.reject_note}</p>}
                    {manage && (
                      <div class="row-actions">
                        <button class="small" onClick={() => setEditingItem(item.id)}>
                          {t("edit")}
                        </button>
                        {item.status === "empty" && (
                          <button class="small quiet" disabled={act.busy} onClick={() => removeItem(item)}>
                            {t("items.remove")}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        {manage && (adding ? <ItemForm requestId={id} onSaved={saved} onCancel={() => setAdding(false)} /> : <button onClick={() => setAdding(true)}>{t("items.add")}</button>)}
      </section>

      <div class="actions">
        {req.status !== "closed" && <button onClick={() => setAsk("close")}>{t("detail.close")}</button>}
        <button class="quiet" onClick={() => setAsk("delete")}>
          {t("detail.delete")}
        </button>
      </div>

      {ask === "link" && (
        <Confirm title={t("detail.new_link")} body={t("detail.new_link_warning")} confirm={t("detail.new_link")} busy={act.busy} error={act.error} onConfirm={makeLink} onCancel={() => setAsk(null)} />
      )}
      {ask === "close" && (
        <Confirm title={t("detail.close")} body={t("detail.close_body")} confirm={t("detail.close")} busy={act.busy} error={act.error} onConfirm={close} onCancel={() => setAsk(null)} />
      )}
      {ask === "delete" && (
        <Confirm title={t("detail.delete")} body={t("detail.delete_body")} confirm={t("detail.delete")} danger busy={act.busy} error={act.error} onConfirm={remove} onCancel={() => setAsk(null)} />
      )}
    </>
  );
}

function DetailsForm({ req, onSaved, onCancel }: { req: RequestDetail; onSaved: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(req.title);
  const [note, setNote] = useState(req.note ?? "");
  const [deadline, setDeadline] = useState(toInput(req.deadline));
  const { busy, error, run } = useAction();

  async function submit(e: Event) {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (title !== req.title) body.title = title;
    if (note !== (req.note ?? "")) body.note = note;
    if (deadline !== toInput(req.deadline)) body.deadline = fromInput(deadline);
    if (!Object.keys(body).length || (await run(() => patch(`/requests/${req.id}`, body)))) onSaved();
  }

  return (
    <form onSubmit={submit}>
      <Field label={t("new.title_field")}>
        <input required maxLength={200} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
      </Field>
      <Field label={t("new.note")}>
        <textarea rows={3} maxLength={2000} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      </Field>
      <Field label={t("new.deadline")}>
        <input type="date" required min={deadline === toInput(req.deadline) ? undefined : toInput(Date.now())} max={toInput(inDays(729))} value={deadline} onInput={(e) => setDeadline(e.currentTarget.value)} />
      </Field>
      <ErrorNote error={error} />
      <div class="actions">
        <button class="primary" disabled={busy}>
          {t("save")}
        </button>
        <button type="button" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

function ItemForm({ requestId, item, onSaved, onCancel }: { requestId: string; item?: Item; onSaved: () => void; onCancel: () => void }) {
  const [label, setLabel] = useState(item?.label ?? "");
  const [help, setHelp] = useState(item?.help ?? "");
  const [required, setRequired] = useState(item?.required ?? true);
  const { busy, error, run } = useAction();

  async function submit(e: Event) {
    e.preventDefault();
    const body = { label, help, required };
    const call = item ? () => patch(`/requests/${requestId}/items/${item.id}`, body) : () => post(`/requests/${requestId}/items`, body);
    if (await run(call)) onSaved();
  }

  return (
    <form class="editor-row" onSubmit={submit}>
      <Field label={t("items.label")}>
        <input required maxLength={200} value={label} onInput={(e) => setLabel(e.currentTarget.value)} />
      </Field>
      <Field label={t("items.help")}>
        <input maxLength={500} value={help} onInput={(e) => setHelp(e.currentTarget.value)} />
      </Field>
      <Check label={t("items.required")} checked={required} onChange={setRequired} />
      <ErrorNote error={error} />
      <div class="row-actions">
        <button class="primary small" disabled={busy}>
          {item ? t("save") : t("items.add")}
        </button>
        <button type="button" class="small" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
