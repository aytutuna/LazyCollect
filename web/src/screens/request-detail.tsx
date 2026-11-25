import { useState } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import { ApiError, del, get, patch, post, put, useAction, useLoad } from "../api";
import { fmtDate, fmtDateTime, fmtDay, fmtSize, fromInput, inDays, isLate, relative, toInput } from "../format";
import { t } from "../i18n";
import type { ActivityRow, Client, Firm, Item, ItemWithFiles, LinkResult, Message, RequestDetail } from "../types";
import { ActivityList } from "./activity";
import { Why } from "../reasons";
import { ExampleField } from "./example-field";
import { IrccDialog } from "./ircc-dialog";
import { QuestionFields, TagFields, newItem, toPayload, type EditItem, type Parent } from "./items-editor";
import { PeopleSection } from "./people";
import { groupByPerson, roleName } from "../people";
import { Review } from "./review";
import { Thread } from "./thread";
import { Unavailable } from "./unavailable";
import { Viewer } from "./viewer";
import { Badge, Check, Confirm, ErrorNote, Field, Loading, statusLabel, statusTone } from "../ui";

const ITEM_TONES = { empty: "grey", submitted: "teal", approved: "green", rejected: "red", unavailable: "amber", waived: "green" };

type Ask = "link" | "close" | "delete" | null;

export function RequestPage({ id, owner }: { id: string; owner: boolean }) {
  const [, go] = useLocation();
  const { data: req, error, reload } = useLoad(() => get<RequestDetail>(`/requests/${id}`), [id]);
  const clients = useLoad(() => get<Client[]>("/clients"));
  const firm = useLoad(() => get<Firm>("/firm"));
  const sent = useLoad(() => get<Message[]>(`/requests/${id}/messages`), [id]);
  const activity = useLoad(() => get<{ rows: ActivityRow[] }>(`/requests/${id}/activity`), [id]);
  const [emailIt, setEmailIt] = useState(true);
  const [mailNote, setMailNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [manage, setManage] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [ircc, setIrcc] = useState(false);
  const [reminded, setReminded] = useState<string | null>(null);
  const nudge = useAction();
  const act = useAction((e) => e instanceof ApiError && e.status === 409 && reload());

  if (!req) return error ? <ErrorNote error={error} /> : <Loading />;

  const editable = req.status === "draft" || req.status === "open" || req.status === "complete";
  const client = clients.data?.find((c) => c.id === req.client_id);
  const clientName = client?.name ?? "";
  const mailBlock = !firm.data || !client ? null : !firm.data.address ? "address" : !client.email || !client.email_ok_at ? "client" : client.email_stop_at ? "stopped" : null;
  const emailing = emailIt && !mailBlock && Boolean(firm.data && client);
  const refresh = () => {
    reload();
    sent.reload();
    activity.reload();
  };
  // an item hidden by an answer is not part of the count
  const shown = req.items.filter((i) => !i.hidden);
  const groups = groupByPerson(req.items, req.people);
  const grouped = groups.some((g) => g.person);
  const dated = req.items.some((i) => i.expiry_rule);
  const received = shown.filter((i) => i.status === "submitted" || i.status === "approved" || i.status === "waived").length;
  const late = isLate(req.deadline) && editable;
  const lastEmail = sent.data?.find((m) => m.status === "sent");
  const lastManual = sent.data?.find((m) => m.manual && m.status !== "failed" && Date.now() - m.sent_at < 86_400_000);
  const remindBlock = mailBlock ?? (req.status !== "open" ? "closed" : null);

  function closeAsk() {
    setAsk(null);
    act.reset();
  }

  async function makeLink() {
    const done = await act.run(async () => {
      const made = await post<LinkResult>(`/requests/${id}/link`, { send_email: emailing });
      setUrl(made.url);
      setMailNote(made.emailed ? t("detail.emailed", { email: client!.email! }) : made.email_failed ? t("detail.email_failed") : null);
      setCopied(false);
      refresh();
    });
    if (done) setAsk(null);
  }

  async function showLink() {
    await act.run(async () => {
      const found = await get<{ url: string | null }>(`/requests/${id}/link`);
      setUrl(found.url);
      setMailNote(found.url ? null : t("detail.link_missing"));
      setCopied(false);
      activity.reload();
    });
  }

  async function remindNow() {
    setReminded(null);
    if (await nudge.run(() => post(`/requests/${id}/remind`))) {
      setReminded(t("detail.remind_sent", { email: client?.email ?? "" }));
      sent.reload();
      activity.reload();
    }
  }

  async function close() {
    if (await act.run(() => post(`/requests/${id}/close`))) {
      setAsk(null);
      setUrl(null);
      reload();
    }
  }

  async function repeatNextYear() {
    await act.run(async () => {
      const made = await post<RequestDetail>(`/requests/${id}/repeat`);
      go(`/requests/${made.id}`);
    });
  }

  async function remove() {
    if (await act.run(() => del(`/requests/${id}`))) go("/");
  }

  async function copy() {
    await navigator.clipboard.writeText(url!).then(() => setCopied(true), () => {});
  }

  async function toggleReminders(on: boolean) {
    if (await act.run(() => patch(`/requests/${id}`, { reminders_on: on }))) reload();
  }

  async function toggleHold() {
    if (await act.run(() => put(`/requests/${id}/hold`, { on: !req!.hold_at }))) {
      reload();
      activity.reload();
    }
  }

  // ask first, so a refusal shows here instead of replacing the page with an error
  async function download() {
    if (await act.run(() => get(`/requests/${id}/export?check=1`))) {
      window.location.href = `/api/requests/${id}/export`;
      setTimeout(activity.reload, 1500);
    }
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
      {error && (
        <p class="error" role="alert">
          {t("detail.refresh_failed")}{" "}
          <button class="link" onClick={reload}>
            {t("retry")}
          </button>
        </p>
      )}

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
              <dd>{t("progress", { done: received, total: shown.length })}</dd>
              {dated && (
                <>
                  <dt>{t("detail.valid_until")}</dt>
                  <dd>{req.valid_until_set ? fmtDay(req.valid_until) : t("detail.valid_until_value", { date: fmtDay(req.valid_until) })}</dd>
                </>
              )}
              {req.sent_at && (
                <>
                  <dt>{t("detail.opened_label")}</dt>
                  <dd>{req.first_opened_at ? t("detail.opened", { date: fmtDate(req.first_opened_at) }) : t("detail.not_opened")}</dd>
                </>
              )}
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
            </>
          ) : (
            <p class="muted">{req.sent_at ? t("detail.link_exists") : t("detail.link_none")}</p>
          )}
          {mailNote && <p class="muted">{mailNote}</p>}
          {req.sent_at && !url && (
            <p>
              <button disabled={act.busy} onClick={showLink}>
                {t("detail.show_link")}
              </button>
            </p>
          )}
          {req.sent_at && (
            <div class="block">
              <p class="muted">{lastEmail ? t("detail.last_email", { what: t(`message.${lastEmail.kind}`), when: fmtDateTime(lastEmail.sent_at) }) : t("detail.last_email_none")}</p>
              <button disabled={nudge.busy || Boolean(remindBlock) || Boolean(lastManual)} onClick={remindNow}>
                {t("detail.remind")}
              </button>
              {reminded && (
                <p class="ok" role="status">
                  {reminded}
                </p>
              )}
              <ErrorNote error={nudge.error} />
              <p class="hint">
                {lastManual
                  ? t("detail.remind_wait", { when: fmtDateTime(lastManual.sent_at + 86_400_000) })
                  : remindBlock === "closed"
                    ? t("detail.remind_closed")
                    : remindBlock === "address"
                      ? t("detail.email_address")
                      : remindBlock === "client"
                        ? t("detail.email_client")
                        : remindBlock === "stopped"
                          ? t("detail.email_stopped")
                          : t("detail.remind_help")}
              </p>
            </div>
          )}
          <div class={req.sent_at ? "block" : ""}>
            {req.sent_at && <p class="muted">{t("detail.replace_help")}</p>}
            {firm.data && client && (
              <>
                <Check label={client.email ? t(req.sent_at ? "detail.replace_email" : "detail.email_to", { email: client.email }) : t("detail.email_to_client")} checked={emailing} disabled={Boolean(mailBlock)} onChange={setEmailIt} />
                {mailBlock === "address" && !req.sent_at && (
                  <p class="muted">
                    <Link href="/settings">{t("detail.email_address")}</Link>
                  </p>
                )}
                {mailBlock === "client" && !req.sent_at && <p class="muted">{t("detail.email_client")}</p>}
                {mailBlock === "stopped" && !req.sent_at && <p class="muted">{t("detail.email_stopped")}</p>}
              </>
            )}
            <button class={req.sent_at ? "" : "primary"} disabled={act.busy || req.items.length === 0} onClick={() => (req.sent_at ? setAsk("link") : makeLink())}>
              {req.sent_at ? t("detail.new_link") : t("detail.create_link")}
            </button>
          </div>
        </section>
      )}

      {editable && req.sent_at && (
        <section>
          <h2>{t("detail.reminders")}</h2>
          <Check label={t("detail.reminders_on")} checked={req.reminders_on} disabled={act.busy} onChange={toggleReminders} />
          <p class="muted">{req.reminders_on && req.next_reminder_at ? t("detail.reminders_next", { date: fmtDate(req.next_reminder_at) }) : t("detail.reminders_none")}</p>
          {sent.data && sent.data.length > 0 ? (
            <ul class="files">
              {sent.data.map((m) => (
                <li key={m.id}>
                  {t(`message.${m.kind}`)} <span class="muted">{fmtDate(m.sent_at)}, {t(m.bounced_at ? "message.bounced" : `message.${m.status}`)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted">{t("detail.messages_none")}</p>
          )}
        </section>
      )}

      <PeopleSection req={req} editable={editable} onChange={refresh} />

      <section>
        <div class="head">
          <h2>{t("detail.items")}</h2>
          {editable && (
            <button class="small" aria-pressed={manage} onClick={() => setManage(!manage)}>
              {manage ? t("detail.done_editing") : t("detail.edit_items")}
            </button>
          )}
        </div>
        {groups.map(({ person, items: of }) => {
          const shown = of.filter((i) => !i.hidden);
          return (
            <div key={person?.position ?? "general"}>
              {grouped && (
                <h3 class="person-head">
                  {person ? person.name : t("client.general")}
                  <span class="muted">
                    {" "}
                    {person ? `${roleName(person.role)}: ` : ""}
                    {t("progress", { done: shown.filter((i) => i.status === "submitted" || i.status === "approved" || i.status === "waived").length, total: shown.length })}
                  </span>
                </h3>
              )}
              <ul class="items">
                {of.map((item) => (
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
                      {item.expiry_rule && <Dates item={item} target={item.expiry_rule === "issue" ? toInput(req.deadline) : req.valid_until} />}
                          {item.show_if_pos !== null && <p class="muted">{condition(req.items, item)}</p>}
                          {item.hidden && <p class="muted">{t("items.hidden")}</p>}
                          {item.kind !== "file" && (
                            <p class="answer">
                              <strong>{t("detail.answer")}:</strong> {answerText(item) || <span class="muted">{t("detail.no_answer")}</span>}
                            </p>
                          )}
                          {item.status === "rejected" && <Why item={item} />}
                          {item.example && <p class="muted">{t("example.has")}</p>}
                          {item.status === "unavailable" && (req.status === "open" || req.status === "complete") && <Unavailable requestId={id} item={item} onDone={reload} />}
                          {item.status === "waived" && item.unavailable_note && <p class="muted">{t("detail.unavailable_reason", { note: item.unavailable_note })}</p>}
                          {item.files.length > 0 && (
                            <ul class="files">
                              {item.files.map((f) => (
                                <li key={f.id}>
                                  <span class="name">
                                    <button class="link" aria-label={t("viewer.open", { name: f.name })} onClick={() => setViewing(f.id)}>
                                      {f.name}
                                    </button>{" "}
                                    <span class="muted">({fmtSize(f.size)})</span>
                                    {f.sent_back_at && <span class="tag">{t("detail.sent_back")}</span>}
                                  </span>
                                  <a class="small-link" href={`/api/files/${f.id}`}>
                                    {t("viewer.download")}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          )}
                          {item.status === "submitted" && (req.status === "open" || req.status === "complete") && <Review requestId={id} item={item} onDone={reload} />}
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
            </div>
          );
        })}
        {req.items.some((i) => i.files.length > 0) && (
          <p>
            <button disabled={act.busy} onClick={download}>
              {t("detail.download")}
            </button>{" "}
            <button onClick={() => setIrcc(true)}>{t("ircc.button")}</button>
          </p>
        )}
        {manage && (adding ? <ItemForm requestId={id} parents={parentsOfRequest(req.items)} onSaved={saved} onCancel={() => setAdding(false)} /> : <button onClick={() => setAdding(true)}>{t("items.add")}</button>)}
      </section>

      <Thread requestId={id} clientName={clientName} editable={req.status === "open" || req.status === "complete"} onChange={activity.reload} />

      <section>
        <h2>{t("detail.records")}</h2>
        {req.hold_at ? <p>{t("detail.hold_on")}</p> : req.keep_until && <p class="muted">{t("detail.kept_until", { date: fmtDate(req.keep_until) })}</p>}
        <p class="muted">{t("detail.hold_help")}</p>
        {(!req.hold_at || owner) && (
          <button disabled={act.busy} onClick={toggleHold}>
            {req.hold_at ? t("detail.hold_release") : t("detail.hold_set")}
          </button>
        )}
      </section>

      <section>
        <h2>{t("detail.activity")}</h2>
        {activity.data && (activity.data.rows.length ? <ActivityList rows={activity.data.rows} /> : <p class="muted">{t("detail.activity_none")}</p>)}
      </section>

      <div class="actions">
        <button disabled={act.busy} onClick={repeatNextYear}>
          {t("detail.repeat")}
        </button>
        {req.status !== "closed" && <button onClick={() => setAsk("close")}>{t("detail.close")}</button>}
        <button class="quiet" onClick={() => setAsk("delete")}>
          {t("detail.delete")}
        </button>
      </div>

      {ircc && <IrccDialog req={req} clientName={clientName} onClose={() => setIrcc(false)} />}
      {viewing && <Viewer req={req} startId={viewing} onClose={() => setViewing(null)} onChanged={refresh} />}

      {ask === "link" && (
        <Confirm title={t("detail.new_link")} body={t("detail.new_link_warning")} confirm={t("detail.new_link")} busy={act.busy} error={act.error} onConfirm={makeLink} onCancel={closeAsk} />
      )}
      {ask === "close" && (
        <Confirm title={t("detail.close")} body={t("detail.close_body")} confirm={t("detail.close")} busy={act.busy} error={act.error} onConfirm={close} onCancel={closeAsk} />
      )}
      {ask === "delete" && (
        <Confirm title={t("detail.delete")} body={t("detail.delete_body")} confirm={t("detail.delete")} danger busy={act.busy} error={act.error} onConfirm={remove} onCancel={closeAsk} />
      )}
    </>
  );
}

function DetailsForm({ req, onSaved, onCancel }: { req: RequestDetail; onSaved: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(req.title);
  const [note, setNote] = useState(req.note ?? "");
  const [deadline, setDeadline] = useState(toInput(req.deadline));
  const [validUntil, setValidUntil] = useState(req.valid_until_set ? req.valid_until : "");
  const { busy, error, run } = useAction();

  async function submit(e: Event) {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (title !== req.title) body.title = title;
    if (note !== (req.note ?? "")) body.note = note;
    if (deadline !== toInput(req.deadline)) body.deadline = fromInput(deadline);
    if (validUntil !== (req.valid_until_set ? req.valid_until : "")) body.valid_until = validUntil || null;
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
      <Field label={t("detail.valid_until")} hint={t("detail.valid_until_hint")}>
        <input type="date" min="1900-01-01" max="2100-12-31" value={validUntil} onInput={(e) => setValidUntil(e.currentTarget.value)} />
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

// an item can hang a condition on any unconditional yes/no or choice item already in the request; its position is its key here
const parentsOfRequest = (items: Item[]): Parent[] =>
  items.filter((i) => i.show_if_pos === null && i.person_pos === null && i.companion === null && (i.kind === "yesno" || i.kind === "choice" || i.kind === "multi")).map((i) => ({ key: i.position, label: i.label, kind: i.kind, options: i.options ?? [] }));

// the date a document was given, what is made of it, and a flag when it falls short; target is the date it has to last to
function Dates({ item, target }: { item: Item; target: string }) {
  const given = item.expiry_rule === "issue" ? item.issued_on : item.expires_on;
  return (
    <>
      <p class="muted flag">
        {!given
          ? t("detail.no_date")
          : item.expiry_rule === "issue"
            ? t("detail.good_until", { date: fmtDay(item.valid_to!), issued: fmtDay(given), n: item.valid_months ?? 0 })
            : t("detail.expires", { date: fmtDay(given) })}
      </p>
      {item.expiry_flag && (
        <p class="flag">
          <Badge tone={item.expiry_flag === "soon" ? "amber" : "red"}>{item.expiry_flag === "short" ? t("flag.short", { date: fmtDay(target) }) : t(`flag.${item.expiry_flag}`)}</Badge>
        </p>
      )}
    </>
  );
}

function answerText(item: Item): string {
  const a = item.answer;
  if (a === null) return "";
  if (Array.isArray(a)) return a.join(", ");
  return item.kind === "yesno" ? t(a === "yes" ? "detail.yes" : "detail.no") : a;
}

function condition(items: Item[], item: Item): string {
  const parent = items.find((p) => p.position === item.show_if_pos);
  const value = parent?.kind === "yesno" ? t(`items.answer_${item.show_if_value}`) : (item.show_if_value ?? "");
  return t("items.condition", { label: parent?.label ?? "", value });
}

// An existing item changes only its wording; a new one can also be a question that depends on an earlier item, named by its position.
function ItemForm({ requestId, item, parents, onSaved, onCancel }: { requestId: string; item?: Item; parents?: Parent[]; onSaved: () => void; onCancel: () => void }) {
  const [expires, setExpires] = useState(item?.expires_on ?? "");
  const [issued, setIssued] = useState(item?.issued_on ?? "");
  const [months, setMonths] = useState(String(item?.valid_months ?? 6));
  const [edit, setEdit] = useState<EditItem>(() => ({ ...newItem(), label: item?.label_base ?? item?.label ?? "", help: item?.help ?? "", required: item?.required ?? true, example: item?.example ?? "" }));
  const { busy, error, run } = useAction();

  async function submit(e: Event) {
    e.preventDefault();
    const [added] = toPayload([{ ...edit, showKey: null }]);
    const body = item
      ? {
          ...(edit.label.trim() !== (item.label_base ?? item.label) && { label: edit.label.trim() }),
          help: edit.help,
          required: edit.required,
          example: edit.example || null,
          ...(item.expiry_rule && { [item.expiry_rule === "issue" ? "issued_on" : "expires_on"]: (item.expiry_rule === "issue" ? issued : expires) || null }),
          ...(item.expiry_rule === "issue" && { valid_months: Number(months) || item.valid_months }),
        }
      : { ...added, ...(edit.showKey === null ? {} : { show_if: { item: edit.showKey, value: edit.showValue } }) };
    const call = item ? () => patch(`/requests/${requestId}/items/${item.id}`, body) : () => post(`/requests/${requestId}/items`, body);
    if (await run(call)) onSaved();
  }

  const change = (patch: Partial<EditItem>) => setEdit({ ...edit, ...patch });
  return (
    <form class="editor-row" onSubmit={submit}>
      <Field label={edit.kind === "file" ? t("items.label") : t("items.question")}>
        <input required maxLength={200} value={edit.label} onInput={(e) => change({ label: e.currentTarget.value })} />
      </Field>
      <Field label={t("items.help")}>
        <input maxLength={500} value={edit.help} onInput={(e) => change({ help: e.currentTarget.value })} />
      </Field>
      <ExampleField value={edit.example} onChange={(example) => change({ example })} />
      {!item && <QuestionFields item={edit} parents={parents ?? []} dependedOn={false} onChange={change} />}
      {!item && <TagFields item={edit} onChange={change} />}
      {item?.expiry_rule === "expiry" && (
        <Field label={t("date.expires")}>
          <input type="date" min="1900-01-01" max="2100-12-31" value={expires} onInput={(e) => setExpires(e.currentTarget.value)} />
        </Field>
      )}
      {item?.expiry_rule === "issue" && (
        <>
          <Field label={t("date.issued")}>
            <input type="date" min="1900-01-01" max="2100-12-31" value={issued} onInput={(e) => setIssued(e.currentTarget.value)} />
          </Field>
          <Field label={t("items.months")}>
            <input type="number" required min={1} max={120} value={months} onInput={(e) => setMonths(e.currentTarget.value)} />
          </Field>
        </>
      )}
      <Check label={t("items.required")} checked={edit.required} onChange={(required) => change({ required })} />
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
