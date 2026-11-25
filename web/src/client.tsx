import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, del, get, post, put, useAction, useLoad } from "./api";
import { fmtDate, fmtDateTime, fmtSize, isLate, relative, setZone } from "./format";
import { t } from "./i18n";
import { UploadQueue, sendJob, type Job } from "./queue";
import { Example, FixList, exampleSrc } from "./reasons";
import type { ClientItem, ClientView, Note } from "./types";
import { groupByPerson, roleName } from "./people";
import { Badge, Field, LegalLink, Loading, errorText } from "./ui";
import { MAX_SIZE, combineToPdf, prepareImage, type Prepared } from "./upload";
import "./styles.css";

const TONES = { empty: "grey", submitted: "teal", approved: "green", rejected: "red", unavailable: "amber", waived: "green" };
// a symbol next to the words, so a status is never told by colour alone
const MARKS = { empty: "○", submitted: "✓", approved: "✓", rejected: "!", unavailable: "–", waived: "✓" };
const RECEIVED = ["submitted", "approved", "waived"];

const token = location.pathname.split("/")[2] ?? "";
const base = `/c/${encodeURIComponent(token)}`;

// Results are spoken through one live region; the text is cleared first so a repeated message is read again.
function announce(text: string) {
  const el = document.getElementById("live");
  if (!el) return;
  el.textContent = "";
  setTimeout(() => (el.textContent = text), 60);
}

// the element to focus once the next render has put it on the page
let pendingFocus: string | null = null;
const focusLater = (id: string) => (pendingFocus = id);

// A result that arrives in the background must not take focus from someone typing or working on another item;
// the live region still announces it.
function mayMoveFocus(target: HTMLElement | null): boolean {
  const here = document.activeElement as HTMLElement | null;
  if (!here || here === document.body) return true;
  if (here.matches("input, textarea, select")) return false;
  const owner = target?.closest("li.item");
  return owner ? owner.contains(here) : Boolean(here.closest("li.item"));
}

const isGone = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 410);

let onUploaded: (job: Job) => void = () => {};
const queue = new UploadQueue(token, sendJob(token), (job) => onUploaded(job));

function useQueue() {
  const [, bump] = useState(0);
  useEffect(() => queue.subscribe(() => bump((n) => n + 1)), []);
  return queue.jobs;
}

function Alert({ error }: { error: unknown }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);
  return error ? (
    <p class="error" role="alert" tabIndex={-1} ref={ref}>
      {errorText(error)}
    </p>
  ) : null;
}

function JobRow({ job, online }: { job: Job; online: boolean }) {
  const { name } = job;
  const failed = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (job.state === "failed") failed.current?.focus();
  }, [job.state]);
  if (job.state === "failed") {
    return (
      <div class="job" role="alert" tabIndex={-1} ref={failed}>
        <p class="error">{t("client.job_failed", { name })}</p>
        <p class="error">{errorText(job.error)}</p>
        <div class="row-actions">
          {!(job.error instanceof ApiError && job.error.code === "missing_file") && (
            <button class="small" onClick={() => queue.retry(job.id)}>
              {t("retry")}
            </button>
          )}
          <button class="small" onClick={() => queue.remove(job.id)}>
            {t("client.remove")}
          </button>
        </div>
      </div>
    );
  }
  if (job.state === "uploading") {
    const percent = Math.round(job.progress * 100);
    return (
      <div class="job">
        <label>
          <span>{t("client.job_uploading", { name, percent })}</span>
          <progress max={1} value={job.progress} />
        </label>
      </div>
    );
  }
  if (job.state === "paused") {
    return (
      <div class="job">
        <p class="muted">{t("client.job_paused", { name })}</p>
        <div class="row-actions">
          <button class="small" onClick={() => queue.remove(job.id)}>
            {t("client.remove")}
          </button>
        </div>
      </div>
    );
  }
  const text =
    job.state === "retrying" && job.retryIn
      ? t("client.job_retry", { name, seconds: job.retryIn })
      : job.state === "retrying" || !online
        ? t("client.job_offline", { name })
        : t("client.job_waiting", { name });
  return (
    <div class="job">
      <p class="muted">{text}</p>
      <div class="row-actions">
        {job.state === "retrying" && online && (
          <button class="small" onClick={() => queue.retry(job.id)}>
            {t("client.try_now")}
          </button>
        )}
        <button class="small" onClick={() => queue.remove(job.id)}>
          {t("client.remove")}
        </button>
      </div>
    </div>
  );
}

function DontHave({ item, firm, onChange, onClose, onCancel }: { item: ClientItem; firm: string; onChange: () => void; onClose: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);

  async function submit(e: Event) {
    e.preventDefault();
    if (await run(() => post(`${base}/items/${item.id}/unavailable`, { note: reason }))) {
      announce(t("client.status_unavailable", { firm }));
      focusLater(`status-${item.id}`);
      onChange();
      onClose();
    }
  }

  return (
    <form class="reason" onSubmit={submit} aria-labelledby={`why-${item.id}`}>
      <h4 id={`why-${item.id}`}>{t("client.dont_have_title")}</h4>
      <label class="field">
        <span class="label">{t("client.dont_have_reason")}</span>
        <textarea ref={field} rows={3} maxLength={500} value={reason} aria-describedby={`why-hint-${item.id}`} onInput={(e) => setReason(e.currentTarget.value)} />
        <span class="hint" id={`why-hint-${item.id}`}>
          {t("client.dont_have_hint")}
        </span>
      </label>
      <Alert error={error} />
      <div class="row-actions">
        <button class="primary" disabled={busy}>
          {t("client.dont_have_save")}
        </button>
        <button type="button" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

// the date of a document, next to its upload; it saves when the field is left
function Dates({ item, onChange }: { item: ClientItem; onChange: () => void }) {
  const issue = item.expiry_rule === "issue";
  const stored = (issue ? item.issued_on : item.expires_on) ?? "";
  const [value, setValue] = useState(stored);
  const { error, run } = useAction();
  useEffect(() => setValue(stored), [stored]);

  async function save() {
    if (value === stored) return;
    if (await run(() => put(`${base}/items/${item.id}/dates`, { [issue ? "issued_on" : "expires_on"]: value || null }))) {
      announce(t("date.saved"));
      onChange();
    }
  }

  return (
    <>
      <Field label={t(issue ? "date.issued" : "date.expires")} hint={issue ? t("date.issued_hint", { n: item.valid_months ?? 0 }) : undefined}>
        <input type="date" min="1900-01-01" max="2100-12-31" value={value} onInput={(e) => setValue(e.currentTarget.value)} onBlur={save} />
      </Field>
      <Alert error={error} />
    </>
  );
}

function statusText(item: ClientItem, firm: string): string {
  switch (item.status) {
    case "approved":
      return t("client.status_approved", { firm });
    case "rejected":
      return t("client.status_rejected");
    case "unavailable":
      return t("client.status_unavailable", { firm });
    case "waived":
      return t("client.status_waived", { firm });
    default:
      return item.files.length ? t("client.status_files", { n: item.files.length }) : t("client.status_empty");
  }
}

function Item({ item, firm, jobs, online, paused, onChange }: { item: ClientItem; firm: string; jobs: Job[]; online: boolean; paused: boolean; onChange: () => void }) {
  const [preparing, setPreparing] = useState(false);
  const [combined, setCombined] = useState(0);
  const [asking, setAsking] = useState(false);
  const [back, setBack] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [Scanner, setScanner] = useState<typeof import("./scan/Scanner").Scanner | null>(null);
  const [scanFailed, setScanFailed] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const action = useAction();
  const open = item.status !== "approved";
  // cancelling the form returns to the button that opened it
  useEffect(() => {
    if (back) {
      trigger.current?.focus();
      setBack(false);
    }
  }, [back]);
  const mine = jobs.filter((j) => j.itemId === item.id);

  async function pick(input: HTMLInputElement) {
    const picked = [...(input.files ?? [])];
    input.value = "";
    if (!picked.length) return;
    setPreparing(true);
    setCombined(0);
    announce(t("client.preparing"));
    const ready: Prepared[] = [];
    for (const file of picked) {
      ready.push(file.type.startsWith("image/") ? await prepareImage(file) : { blob: file, name: file.name, jpeg: false });
    }
    await submit(ready);
  }

  // the files go up as they are, except that photos are combined into one PDF when there is more than one
  async function submit(files: Prepared[]) {
    let ready = files;
    setPreparing(true);
    setCombined(0);
    const photos = ready.filter((r) => r.jpeg);
    // a few kB per page covers the PDF structure; past the cap the photos go up separately
    const estimate = photos.reduce((sum, p) => sum + p.blob.size + 2048, 0);
    if (photos.length > 1 && estimate <= MAX_SIZE) {
      try {
        const pdf = await combineToPdf(photos.map((p) => p.blob), item.label);
        if (pdf.blob.size <= MAX_SIZE) {
          ready = [...ready.filter((r) => !r.jpeg), pdf];
          setCombined(photos.length);
        }
      } catch {
        // the photos go up one by one instead
      }
    }
    setPreparing(false);
    await queue.add(item.id, ready);
  }

  // when the scanner cannot load (a bad connection), the phone's own camera app takes the photo instead
  function openScanner() {
    setScanFailed(false);
    import("./scan/Scanner")
      .then((m) => setScanner(() => m.Scanner))
      .catch(() => {
        setScanFailed(true);
        announce(t("scan.load_failed"));
        camera.current?.click();
      });
  }

  async function remove(id: string, name: string) {
    if (await action.run(() => del(`${base}/files/${id}`))) {
      announce(t("client.removed", { name }));
      focusLater(`status-${item.id}`);
      onChange();
    }
  }

  async function found() {
    if (await action.run(() => del(`${base}/items/${item.id}/unavailable`))) {
      focusLater(`status-${item.id}`);
      onChange();
    }
  }

  return (
    <li class="item" aria-labelledby={`label-${item.id}`}>
      <div class="main">
        <div class="line">
          <strong id={`label-${item.id}`}>{item.label}</strong>
          <Badge tone={TONES[item.status]}>
            <span aria-hidden="true">{MARKS[item.status]} </span>
            {t(`client.${item.status}`)}
          </Badge>
        </div>
        {item.help && <div class="muted">{item.help}</div>}
        <Example item={item} src={exampleSrc(item.example ?? "", `/api${base}/items/${item.id}/example`)} />
        <p class="item-status" id={`status-${item.id}`} tabIndex={-1}>
          {statusText(item, firm)}
        </p>
        {item.status === "rejected" && (item.reject_note || item.reject_reasons?.length > 0) && (
          <div class="callout">
            <strong>{t("client.rejected_title")}</strong>
            <FixList item={item} />
            {item.reject_note && <p>{item.reject_note}</p>}
          </div>
        )}
        {item.status === "unavailable" && item.unavailable_note && <p class="muted reason-text">{t("client.unavailable_reason", { note: item.unavailable_note })}</p>}
        {item.status === "submitted" && item.reject_note && <p class="muted">{t("client.earlier_note", { note: item.reject_note })}</p>}

        {item.files.length > 0 && (
          <ul class="files">
            {item.files.map((f) => (
              <li key={f.id}>
                <span class="name">
                  {f.name} <span class="muted">({fmtSize(f.size)})</span>
                  {f.sent_back_at && <span class="tag">{t("client.sent_back")}</span>}
                </span>
                {open && (
                  <button class="small quiet" disabled={action.busy} aria-label={t("client.remove_file", { name: f.name })} onClick={() => remove(f.id, f.name)}>
                    {t("client.remove")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {mine.map((job) => (
          <JobRow key={job.id} job={job} online={online} />
        ))}
        {open && item.expiry_rule && <Dates item={item} onChange={onChange} />}
        {preparing && <p class="muted">{t("client.preparing")}</p>}
        {combined > 0 && <p class="muted">{t("client.combined", { n: combined })}</p>}
        <Alert error={action.error} />
        {scanFailed && (
          <p class="error" role="alert">
            {t("scan.load_failed")}{" "}
            <button class="link" onClick={() => location.reload()}>
              {t("scan.reload")}
            </button>
          </p>
        )}

        {open && (
          <>
            {paused && <p class="muted">{t("client.item_paused")}</p>}
            <div class="row-actions buttons">
              {!paused && (
                <>
                  <button class="primary" disabled={preparing} aria-describedby={`label-${item.id}`} onClick={openScanner}>
                    {t("scan.open")}
                  </button>
                  <button disabled={preparing} aria-describedby={`label-${item.id}`} onClick={() => picker.current?.click()}>
                    {t("client.choose_file")}
                  </button>
                </>
              )}
              {item.status === "unavailable" ? (
                <button class="quiet-link" disabled={action.busy} aria-describedby={`label-${item.id}`} onClick={found}>
                  {t("client.found_it")}
                </button>
              ) : (
                (item.status === "empty" || item.status === "rejected") &&
                !asking && (
                  <button ref={trigger} class="quiet-link" aria-describedby={`label-${item.id}`} onClick={() => setAsking(true)}>
                    {t("client.dont_have")}
                  </button>
                )
              )}
            </div>
            <input ref={camera} type="file" accept="image/*" capture="environment" hidden tabIndex={-1} onChange={(e) => pick(e.currentTarget)} />
            <input ref={picker} type="file" accept="image/*,application/pdf" multiple hidden tabIndex={-1} onChange={(e) => pick(e.currentTarget)} />
          </>
        )}
        {Scanner && (
          <Scanner
            label={item.label}
            onClose={() => setScanner(null)}
            onDone={(files) => {
              setScanner(null);
              void submit(files);
            }}
          />
        )}
        {asking && <DontHave item={item} firm={firm} onChange={onChange} onClose={() => setAsking(false)} onCancel={() => { setAsking(false); setBack(true); }} />}
      </div>
    </li>
  );
}

type Save = (item: ClientItem, answer: string | string[] | null) => Promise<boolean>;

// a dot, or a comma followed by one or two digits, marks the decimals; thousands separators are refused, since 1,000 reads two ways
const NUMBER = /^-?\d{1,15}(\.\d{1,6}|,\d{1,2})?$/;

function answerText(item: ClientItem): string {
  const a = item.answer;
  if (a === null) return "";
  if (Array.isArray(a)) return a.join(", ");
  return item.kind === "yesno" ? t(a === "yes" ? "client.yes" : "client.no") : a;
}

// A question answers in place and saves as it is changed: radios and boxes at once, typed answers when the field is left.
function Question({ item, firm, save }: { item: ClientItem; firm: string; save: Save }) {
  const [text, setText] = useState(typeof item.answer === "string" ? item.answer : "");
  // choices show at once and are saved behind them
  const [picked, setPicked] = useState(item.answer);
  const [bad, setBad] = useState(false);
  const { busy, error, run } = useAction();
  const open = item.status !== "approved";
  const grouped = item.kind === "yesno" || item.kind === "choice" || item.kind === "multi";
  const field = `in-${item.id}`;
  const describedBy = [item.help && `help-${item.id}`, `status-${item.id}`, bad && `bad-${item.id}`].filter(Boolean).join(" ");

  // an answer that arrives from a reload replaces what is shown, unless the person is typing in the field
  useEffect(() => {
    setPicked(item.answer);
    if (document.activeElement?.id !== field) setText(typeof item.answer === "string" ? item.answer : "");
  }, [item.answer]);

  const send = async (answer: string | string[] | null) => {
    setPicked(answer);
    const ok = await run(() => save(item, answer));
    if (!ok) setPicked(item.answer);
  };

  // a typed answer; the same value is saved again when the account sent the question back, since that is how it is confirmed
  function leave(again = false) {
    const value = text.trim();
    if (!again && value === (typeof item.answer === "string" ? item.answer : "")) return;
    if (item.kind === "number" && value && !NUMBER.test(value)) {
      setBad(true);
      return;
    }
    setBad(false);
    send(value === "" ? null : item.kind === "number" ? value.replace(",", ".") : value);
  }

  const keep = () => (grouped ? send(item.answer) : leave(true));

  const chosen = Array.isArray(picked) ? picked : [];
  const input = () => {
    switch (item.kind) {
      case "yesno":
      case "choice": {
        const options = item.kind === "yesno" ? ["yes", "no"] : (item.options ?? []);
        return (
          <div role="radiogroup" aria-labelledby={`label-${item.id}`} aria-describedby={describedBy}>
            {options.map((o) => (
              <label class="check" key={o}>
                <input type="radio" name={`q-${item.id}`} value={o} checked={picked === o} onChange={() => send(o)} />
                <span>{item.kind === "yesno" ? t(o === "yes" ? "client.yes" : "client.no") : o}</span>
              </label>
            ))}
          </div>
        );
      }
      case "multi":
        return (
          <div role="group" aria-labelledby={`label-${item.id}`} aria-describedby={describedBy}>
            {(item.options ?? []).map((o) => (
              <label class="check" key={o}>
                <input
                  type="checkbox"
                  checked={chosen.includes(o)}
                  onChange={(e) => {
                    const next = (item.options ?? []).filter((x) => (x === o ? e.currentTarget.checked : chosen.includes(x)));
                    send(next.length ? next : null);
                  }}
                />
                <span>{o}</span>
              </label>
            ))}
          </div>
        );
      case "longtext":
        return <textarea id={field} rows={5} maxLength={5000} value={text} aria-describedby={describedBy} onInput={(e) => setText(e.currentTarget.value)} onBlur={() => leave()} />;
      case "date":
        return <input id={field} type="date" min="1900-01-01" max="2100-12-31" value={text} aria-describedby={describedBy} onInput={(e) => setText(e.currentTarget.value)} onBlur={() => leave()} />;
      case "number":
        return (
          <input id={field} type="text" inputMode="decimal" autoComplete="off" value={text} aria-invalid={bad} aria-describedby={describedBy} onInput={(e) => setText(e.currentTarget.value)} onBlur={() => leave()} />
        );
      default:
        return <input id={field} type="text" maxLength={500} value={text} aria-describedby={describedBy} onInput={(e) => setText(e.currentTarget.value)} onBlur={() => leave()} />;
    }
  };

  const status = {
    approved: t("client.status_approved", { firm }),
    rejected: t("client.status_rejected_question"),
    empty: t("client.status_unanswered"),
  }[item.status as string] ?? t("client.status_answered");
  return (
    <li class="item question" aria-labelledby={`label-${item.id}`}>
      <div class="main">
        <div class="line">
          {grouped ? (
            <strong id={`label-${item.id}`}>{item.label}</strong>
          ) : (
            <label id={`label-${item.id}`} for={field}>
              <strong>{item.label}</strong>
            </label>
          )}
          <Badge tone={TONES[item.status]}>
            <span aria-hidden="true">{MARKS[item.status]} </span>
            {t(`client.${item.status}`)}
          </Badge>
        </div>
        {item.help && (
          <div class="muted" id={`help-${item.id}`}>
            {item.help}
          </div>
        )}
        <Example item={item} src={exampleSrc(item.example ?? "", `/api${base}/items/${item.id}/example`)} />
        <p class="item-status" id={`status-${item.id}`} tabIndex={-1}>
          {status}
        </p>
        {item.status === "rejected" && (item.reject_note || item.reject_reasons?.length > 0) && (
          <div class="callout">
            <strong>{t("client.rejected_question")}</strong>
            <FixList item={item} />
            {item.reject_note && <p>{item.reject_note}</p>}
          </div>
        )}
        {open ? input() : <p class="answer">{answerText(item)}</p>}
        {item.status === "rejected" && item.answer !== null && (
          <button class="quiet-link keep" disabled={busy} aria-describedby={`label-${item.id}`} onClick={keep}>
            {t("client.keep_answer")}
          </button>
        )}
        {bad && (
          <p class="error" id={`bad-${item.id}`}>
            {t("client.number_invalid")}
          </p>
        )}
        <Alert error={error} />
      </div>
    </li>
  );
}

function ItemList({ items, firm, jobs, online, paused, onChange, save }: { items: ClientItem[]; firm: string; jobs: Job[]; online: boolean; paused: boolean; onChange: () => void; save: Save }) {
  return (
    <ul class="items">
      {items.map((item) =>
        item.kind === "file" ? (
          <Item key={item.id} item={item} firm={firm} jobs={jobs} online={online} paused={paused} onChange={onChange} />
        ) : (
          <Question key={item.id} item={item} firm={firm} save={save} />
        ),
      )}
    </ul>
  );
}

// what is asked of each person under their name, with how far they have got
function Checklist({ items, firm, jobs, online, paused, onChange, save, people }: { items: ClientItem[]; firm: string; jobs: Job[]; online: boolean; paused: boolean; onChange: () => void; save: Save; people: ClientView["people"] }) {
  const list = (of: ClientItem[], nested: boolean) => {
    const optional = of.filter((i) => !i.required);
    return (
      <>
        <ItemList items={of.filter((i) => i.required)} firm={firm} jobs={jobs} online={online} paused={paused} onChange={onChange} save={save} />
        {optional.length > 0 && (
          <>
            {nested ? <h4 class="optional">{t("client.optional")}</h4> : <h3 class="optional">{t("client.optional")}</h3>}
            <ItemList items={optional} firm={firm} jobs={jobs} online={online} paused={paused} onChange={onChange} save={save} />
          </>
        )}
      </>
    );
  };
  const groups = groupByPerson(items, people);
  if (groups.length === 0 || (groups.length === 1 && !groups[0].person)) return list(items, false);
  return (
    <>
      {groups.map(({ person, items: of }) => {
        const scope = of.some((i) => i.required) ? of.filter((i) => i.required) : of;
        const done = scope.filter((i) => RECEIVED.includes(i.status)).length;
        return (
          <section class="person" key={person?.position ?? "general"} aria-labelledby={`person-${person?.position ?? "general"}`}>
            <h3 id={`person-${person?.position ?? "general"}`}>{person ? person.name : t("client.general")}</h3>
            <p class="muted">
              {person && `${roleName(person.role)}, `}
              {t("client.person_progress", { done, total: scope.length })}
            </p>
            {list(of, true)}
          </section>
        );
      })}
    </>
  );
}

function Thread({ firm, notes, onChange }: { firm: string; notes: Note[]; onChange: () => void }) {
  const [body, setBody] = useState("");
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();

  async function submit(e: Event) {
    e.preventDefault();
    setSent(false);
    if (await run(() => post(`${base}/notes`, { body }))) {
      setBody("");
      setSent(true);
      announce(t("client.notes_sent"));
      onChange();
    }
  }

  return (
    <section aria-labelledby="notes-title">
      <h2 id="notes-title">{t("client.notes_title", { firm })}</h2>
      <p class="muted">{t("client.notes_intro", { firm })}</p>
      {notes.length > 0 && (
        <ol class="thread">
          {notes.map((n) => (
            <li key={n.id} class={n.author === "client" ? "from-you" : "from-firm"}>
              <p class="who">
                <strong>{n.author === "client" ? t("client.notes_you") : firm}</strong> <span class="muted">{fmtDateTime(n.created_at)}</span>
              </p>
              <p class="body">{n.body}</p>
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={submit}>
        <label class="field">
          <span class="label">{t("client.notes_label")}</span>
          <textarea required rows={4} maxLength={2000} value={body} aria-describedby="notes-left" onInput={(e) => setBody(e.currentTarget.value)} />
          <span class="hint" id="notes-left">
            {t("client.notes_left", { n: 2000 - body.length })}
          </span>
        </label>
        <Alert error={error} />
        {sent && <p class="ok">{t("client.notes_sent")}</p>}
        <button class="primary" disabled={busy || !body.trim()}>
          {t("client.notes_send")}
        </button>
      </form>
    </section>
  );
}

function Page() {
  const { data, error, reload } = useLoad(() => get<ClientView>(base));
  const jobs = useQueue();
  const [online, setOnline] = useState(navigator.onLine);
  const wasDone = useRef<boolean | null>(null);
  const checked = useRef(new Set<string>());
  const [removed, setRemoved] = useState(0);
  const doneHeading = useRef<HTMLHeadingElement>(null);

  onUploaded = (job) => {
    announce(t("client.uploaded", { name: job.name }));
    focusLater(`status-${job.itemId}`);
    reload();
  };

  useEffect(() => {
    queue.restore();
    const up = () => {
      setOnline(true);
      queue.online();
    };
    const down = () => {
      setOnline(false);
      announce(t("client.offline"));
    };
    addEventListener("online", up);
    addEventListener("offline", down);
    return () => {
      removeEventListener("online", up);
      removeEventListener("offline", down);
    };
  }, []);

  // files that waited on a paused account go up once the page says it takes files again
  useEffect(() => {
    if (data && !data.paused) queue.resume();
  }, [data?.paused]);

  // an upload met a paused account the page did not know about: look again
  useEffect(() => {
    if (data && !data.paused && jobs.some((j) => j.state === "paused") && !checked.current.has("paused")) {
      checked.current.add("paused");
      reload();
    }
  }, [jobs]);

  // the link is gone: nothing stored for it can ever be sent
  useEffect(() => {
    if (error && isGone(error)) queue.forget().then(setRemoved);
  }, [error]);

  // a failed upload with a 404 may mean the link was replaced; the page asks again to find out
  useEffect(() => {
    for (const job of jobs) {
      if (job.state === "failed" && job.error instanceof ApiError && job.error.status === 404 && !checked.current.has(job.id)) {
        checked.current.add(job.id);
        reload();
      }
    }
  }, [jobs]);

  // files waiting for an item the account has since removed would never go anywhere
  useEffect(() => {
    if (!data || error) return;
    const ids = new Set(data.items.map((i) => i.id));
    const lost = jobs.filter((j) => !ids.has(j.itemId) && j.state !== "uploading");
    if (lost.length) {
      lost.forEach((j) => queue.remove(j.id));
      announce(t("client.items_gone"));
    }
  }, [data, jobs]);

  const scope = data ? (data.items.some((i) => i.required) ? data.items.filter((i) => i.required) : data.items) : [];
  const received = scope.filter((i) => RECEIVED.includes(i.status)).length;
  const unavailable = scope.filter((i) => i.status === "unavailable").length;
  const finished = Boolean(data) && scope.length > 0 && received + unavailable === scope.length;

  useEffect(() => {
    if (pendingFocus) {
      const el = document.getElementById(pendingFocus);
      if (el && mayMoveFocus(el)) el.focus();
      pendingFocus = null;
    }
    // the first look only records the state; after that, becoming finished moves focus to the message
    if (data) {
      if (wasDone.current === false && finished) {
        if (mayMoveFocus(null)) doneHeading.current?.focus();
        announce(t("client.all_done_title"));
      }
      wasDone.current = finished;
    }
  });

  useEffect(() => {
    if (data) document.title = `${data.title} - ${data.firm_name}`;
  }, [data?.title, data?.firm_name]);

  if (error && (!data || isGone(error))) {
    const gone = isGone(error);
    return (
      <main class="client-page">
        <h1>{gone ? t("client.gone_title") : t("client.error_title")}</h1>
        <p>{gone ? t("client.gone") : t(error instanceof ApiError && error.status === 429 ? "error.rate_limited" : "client.error")}</p>
        {gone && removed > 0 && <p>{t("client.files_removed")}</p>}
      </main>
    );
  }
  if (!data) return <Loading />;
  setZone(data.tz);

  // the answer decides which other items apply, so what changed is told through the live region
  const save: Save = async (item, answer) => {
    const { items } = await put<{ items: ClientItem[] }>(`${base}/items/${item.id}/answer`, { answer });
    const before = new Set(data.items.map((i) => i.id));
    const after = new Set(items.map((i) => i.id));
    const shown = items.filter((i) => !before.has(i.id)).length;
    const hidden = data.items.filter((i) => !after.has(i.id)).length;
    announce([t("client.answer_saved"), shown && t("client.items_shown", { n: shown }), hidden && t("client.items_hidden", { n: hidden })].filter(Boolean).join(" "));
    reload();
    return true;
  };

  const firm = data.firm_name;
  const contact = data.contact && (data.contact.email || data.contact.phone || data.contact.address) ? data.contact : null;
  return (
    <main class="client-page">
      <div id="live" class="sr-only" role="status" aria-live="polite" />
      <p class="firm">{firm}</p>
      <h1>{data.title}</h1>
      {data.note && <p class="request-note">{data.note}</p>}
      <p>
        {t("client.due")}: <strong class={isLate(data.deadline) ? "late" : ""}>{fmtDate(data.deadline)}</strong> ({relative(data.deadline)})
      </p>
      <p class="muted">{t("client.privacy", { firm })}</p>
      {error && (
        <p class="error" role="alert">
          {t("client.refresh_failed")}{" "}
          <button class="link" onClick={reload}>
            {t("retry")}
          </button>
        </p>
      )}

      {data.paused && (
        <div class="banner" role="status">
          <strong>{t("client.paused_title")}</strong>
          <p>{t("client.paused", { firm })}</p>
        </div>
      )}

      {(jobs.length > 0 || !online) && (
        <div class="banner">
          {jobs.length > 0 && <strong>{t("client.waiting", { n: jobs.length })}</strong>}
          {!online && <p>{t("client.offline")}</p>}
          {jobs.length > 0 && !queue.persistent && <p>{t("client.no_storage")}</p>}
        </div>
      )}

      <section class="progress-card" aria-labelledby="progress-text">
        <p id="progress-text">
          <strong>{t("client.progress", { done: received, total: scope.length })}</strong>
          {unavailable > 0 && <span class="muted">, {t("client.progress_na", { n: unavailable })}</span>}
        </p>
        <progress max={scope.length || 1} value={received + unavailable} aria-labelledby="progress-text" />
      </section>

      {finished && (
        <section class="done" aria-labelledby="done-title">
          <h2 id="done-title" tabIndex={-1} ref={doneHeading}>
            {t("client.all_done_title")}
          </h2>
          <p>{t("client.all_done_body", { firm })}</p>
        </section>
      )}

      <section aria-labelledby="checklist-title">
        <h2 id="checklist-title">{t("client.checklist")}</h2>
        <Checklist items={data.items} people={data.people ?? []} firm={firm} jobs={jobs} online={online} paused={data.paused} onChange={reload} save={save} />
      </section>

      <Thread firm={firm} notes={data.notes} onChange={reload} />

      {contact && (
        <section aria-labelledby="contact-title">
          <h2 id="contact-title">{t("client.contact_title")}</h2>
          <p>
            <strong>{contact.name ?? firm}</strong>
          </p>
          <dl class="facts">
            {contact.email && (
              <>
                <dt>{t("client.contact_email")}</dt>
                <dd>
                  <a href={`mailto:${contact.email}`}>{contact.email}</a>
                </dd>
              </>
            )}
            {contact.phone && (
              <>
                <dt>{t("client.contact_phone")}</dt>
                <dd>
                  <a href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}>{contact.phone}</a>
                </dd>
              </>
            )}
            {contact.address && (
              <>
                <dt>{t("client.contact_address")}</dt>
                <dd class="address">{contact.address}</dd>
              </>
            )}
          </dl>
        </section>
      )}

      <section aria-labelledby="trust-title">
        <h2 id="trust-title">{t("client.trust_title")}</h2>
        <ul class="trust">
          <li>{t("client.trust_private")}</li>
          <li>{t("client.trust_encrypted")}</li>
          <li>{t("client.trust_access", { firm })}</li>
          <li>{t("client.trust_expires", { date: fmtDate(data.expires_at) })}</li>
        </ul>
        <p>
          <LegalLink page="privacy">{t("client.privacy_link")}</LegalLink>
        </p>
      </section>
    </main>
  );
}

render(<Page />, document.getElementById("app")!);
