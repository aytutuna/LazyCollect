import { useState } from "preact/hooks";
import { ApiError, post, useAction } from "../api";
import { t } from "../i18n";
import type { ItemWithFiles } from "../types";
import { ErrorNote, Field } from "../ui";

export function Review({ requestId, item, onDone }: { requestId: string; item: ItemWithFiles; onDone: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction((e) => e instanceof ApiError && e.status === 409 && onDone());

  async function decide(decision: "approve" | "reject") {
    if (await run(() => post(`/requests/${requestId}/items/${item.id}/review`, { decision, note, files: item.files.map((f) => f.id) }))) onDone();
  }

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
        decide("reject");
      }}
    >
      <Field label={t("detail.reject_note")} hint={t("detail.reject_hint")}>
        <textarea required rows={3} maxLength={500} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      </Field>
      <ErrorNote error={error} />
      <div class="row-actions">
        <button class="primary small" disabled={busy}>
          {t("detail.reject_send")}
        </button>
        <button type="button" class="small" onClick={() => setRejecting(false)}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
