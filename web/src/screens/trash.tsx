import { useState } from "preact/hooks";
import { get, post, useAction, useLoad } from "../api";
import { fmtDate } from "../format";
import { t } from "../i18n";
import type { TrashClient, TrashRequest } from "../types";
import { ErrorNote, Loading } from "../ui";

export function Trash() {
  const { data, error, reload } = useLoad(() => get<{ requests: TrashRequest[]; clients: TrashClient[] }>("/trash"));
  const [note, setNote] = useState<string | null>(null);
  const act = useAction();

  async function restore(kind: "requests" | "clients", id: string) {
    setNote(null);
    if (await act.run(() => post(`/${kind}/${id}/restore`))) {
      setNote(t(kind === "requests" ? "trash.restored_request" : "trash.restored_client"));
      reload();
    }
  }

  return (
    <>
      <h1>{t("trash.title")}</h1>
      <p class="muted">{t("trash.intro")}</p>
      <ErrorNote error={error ?? act.error} />
      {note && <p class="ok">{note}</p>}
      {!data ? (
        !error && <Loading />
      ) : data.requests.length + data.clients.length === 0 ? (
        <p class="muted">{t("trash.empty")}</p>
      ) : (
        <>
          {data.requests.length > 0 && (
            <section>
              <h2>{t("trash.requests")}</h2>
              <ul class="files">
                {data.requests.map((r) => (
                  <li key={r.id}>
                    <span>
                      <strong>{r.title}</strong>{" "}
                      <span class="muted">
                        {r.client_name}, {r.deleted_reason === "retention" ? `${t("trash.retention")}, ` : ""}
                        {t("trash.removed", { date: fmtDate(r.purge_at) })}
                      </span>
                    </span>
                    <button class="small" disabled={act.busy} onClick={() => restore("requests", r.id)}>
                      {t("trash.restore")}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.clients.length > 0 && (
            <section>
              <h2>{t("trash.clients")}</h2>
              <ul class="files">
                {data.clients.map((c) => (
                  <li key={c.id}>
                    <span>
                      <strong>{c.name}</strong> <span class="muted">{t("trash.removed", { date: fmtDate(c.purge_at) })}</span>
                    </span>
                    <button class="small" disabled={act.busy} onClick={() => restore("clients", c.id)}>
                      {t("trash.restore")}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
