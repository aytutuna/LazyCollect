import { useState } from "preact/hooks";
import { ApiError, post, useAction } from "../api";
import { t } from "../i18n";
import type { ItemWithFiles } from "../types";
import { ErrorNote, Field } from "../ui";

export function Unavailable({ requestId, item, onDone }: { requestId: string; item: ItemWithFiles; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction((e) => e instanceof ApiError && e.status === 409 && onDone());

  async function decide(decision: "accept" | "ask") {
    if (await run(() => post(`/requests/${requestId}/items/${item.id}/unavailable`, { decision, note }))) onDone();
  }

  return (
    <div class="callout notice">
      <strong>{t("detail.unavailable_title")}</strong>
      <p>{item.unavailable_note ? t("detail.unavailable_reason", { note: item.unavailable_note }) : t("detail.unavailable_none")}</p>
      {asking ? (
        <form
          class="editor-row"
          onSubmit={(e) => {
            e.preventDefault();
            decide("ask");
          }}
        >
          <Field label={t("detail.ask_again_note")} hint={t("detail.ask_again_hint")}>
            <textarea required rows={3} maxLength={500} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
          </Field>
          <ErrorNote error={error} />
          <div class="row-actions">
            <button class="primary small" disabled={busy}>
              {t("detail.ask_again_send")}
            </button>
            <button type="button" class="small" onClick={() => setAsking(false)}>
              {t("cancel")}
            </button>
          </div>
        </form>
      ) : (
        <>
          <ErrorNote error={error} />
          <div class="row-actions">
            <button class="primary small" disabled={busy} onClick={() => decide("accept")}>
              {t("detail.accept_unavailable")}
            </button>
            <button class="small" disabled={busy} onClick={() => setAsking(true)}>
              {t("detail.ask_again")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
