import { useState } from "preact/hooks";
import { get, post, useAction, useLoad } from "../api";
import { fmtDateTime } from "../format";
import { t } from "../i18n";
import type { Note, Thread as ThreadData } from "../types";
import { Badge, ErrorNote, Field, Loading } from "../ui";

type Reply = { note: Note; emailed: boolean; email: string };

export function Thread({ requestId, clientName, editable, onChange }: { requestId: string; clientName: string; editable: boolean; onChange: () => void }) {
  const { data, error, reload } = useLoad(() => get<ThreadData>(`/requests/${requestId}/notes`), [requestId]);
  const [body, setBody] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const send = useAction();

  async function submit(e: Event) {
    e.preventDefault();
    setResult(null);
    let reply: Reply | undefined;
    if (await send.run(async () => (reply = await post<Reply>(`/requests/${requestId}/notes`, { body })))) {
      setBody("");
      setResult(t(`detail.thread_email_${reply!.email}`));
      reload();
      onChange();
    }
  }

  return (
    <section>
      <div class="head">
        <h2>{t("detail.thread")}</h2>
        {data && data.unanswered > 0 && <Badge tone="amber">{t("detail.thread_unanswered", { n: data.unanswered })}</Badge>}
      </div>
      {!data ? (
        error ? <ErrorNote error={error} /> : <Loading />
      ) : data.notes.length === 0 ? (
        <p class="muted">{t("detail.thread_none")}</p>
      ) : (
        <ol class="thread">
          {data.notes.map((n) => (
            <li key={n.id} class={n.author === "client" ? "from-client" : "from-us"}>
              <p class="who">
                <strong>{n.author === "client" ? clientName : t("detail.thread_you")}</strong> <span class="muted">{fmtDateTime(n.created_at)}</span>
              </p>
              <p class="body">{n.body}</p>
            </li>
          ))}
        </ol>
      )}
      {editable && (
        <form onSubmit={submit}>
          <Field label={t("detail.thread_reply")} hint={t("detail.thread_hint")}>
            <textarea required rows={3} maxLength={2000} value={body} onInput={(e) => setBody(e.currentTarget.value)} />
          </Field>
          <ErrorNote error={send.error} />
          {result && (
            <p class="ok" role="status">
              {result}
            </p>
          )}
          <button class="primary" disabled={send.busy || !body.trim()}>
            {t("detail.thread_send")}
          </button>
        </form>
      )}
    </section>
  );
}
