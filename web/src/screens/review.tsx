import { useState } from "preact/hooks";
import { ApiError, post, useAction } from "../api";
import { t } from "../i18n";
import { reasonsFor } from "../reasons";
import type { ItemWithFiles } from "../types";
import { Check, ErrorNote, Field } from "../ui";

export function Review({ requestId, item, onDone }: { requestId: string; item: ItemWithFiles; onDone: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction((e) => e instanceof ApiError && e.status === 409 && onDone());
  const file = item.kind === "file";
  const other = reasons.includes("other");
  // a question can go back with only a note; "other" is explained by the note
  const need = other && !note.trim() ? t("detail.reject_other_note") : !reasons.length && (file || !note.trim()) ? t(file ? "detail.reject_need" : "detail.reject_need_note") : "";

  async function decide(decision: "approve" | "reject") {
    const body = { decision, files: item.files.map((f) => f.id), answered_at: item.answer_at, ...(decision === "reject" ? { reasons, note } : {}) };
    if (await run(() => post(`/requests/${requestId}/items/${item.id}/review`, body))) onDone();
  }

  const toggle = (code: string, on: boolean) => setReasons(reasonsFor(item.kind).filter((c) => (c === code ? on : reasons.includes(c))));

  if (!rejecting) {
    return (
      <>
        <ErrorNote error={error} />
        <div class="row-actions">
          <button class="primary small" disabled={busy} onClick={() => decide("approve")}>
            {t("detail.approve")}
          </button>
          <button class="small" disabled={busy} onClick={() => setRejecting(true)}>
            {t("detail.reject")}
          </button>
        </div>
      </>
    );
  }
  return (
    <form
      class="editor-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (!need) decide("reject");
      }}
    >
      <fieldset class="reasons-pick">
        <legend>{t("detail.reject_reasons")}</legend>
        <div class="reasons-grid">
          {reasonsFor(item.kind).map((code) => (
            <Check key={code} label={t(`reason.${code}`)} checked={reasons.includes(code)} onChange={(on) => toggle(code, on)} />
          ))}
        </div>
        <span class="hint">{t("detail.reject_reasons_hint")}</span>
      </fieldset>
      <Field label={t("detail.reject_note")} hint={t(file ? "detail.reject_hint" : "detail.reject_hint_question")}>
        <textarea rows={3} maxLength={500} required={other} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      </Field>
      {need && <p class="muted" role="status">{need}</p>}
      <ErrorNote error={error} />
      <div class="row-actions">
        <button class="primary small" disabled={busy || Boolean(need)}>
          {t("detail.reject_send")}
        </button>
        <button type="button" class="small" onClick={() => setRejecting(false)}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
