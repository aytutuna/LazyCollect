import { useEffect, useRef, useState } from "preact/hooks";
import { post } from "../api";
import { fmtSize } from "../format";
import { t } from "../i18n";
import { DEFAULT_LIMIT, LIMITS, irccSources, prepareAll, words, type Note, type Row } from "../ircc";
import type { RequestDetail } from "../types";
import { Badge, Field } from "../ui";

type State = { at: "idle" } | { at: "running"; done: number; label: string } | { at: "done"; rows: Row[]; url: string } | { at: "failed" };

const noteText = (n: Note) => t(`ircc.note.${n.code}`, { name: n.name ?? "" });

export function IrccDialog({ req, clientName, onClose }: { req: RequestDetail; clientName: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const stop = useRef<AbortController | undefined>(undefined);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [state, setState] = useState<State>({ at: "idle" });
  const sources = irccSources(req.items);
  const total = sources.length;

  useEffect(() => {
    ref.current?.showModal();
    return () => {
      stop.current?.abort();
      ref.current?.close();
    };
  }, []);
  useEffect(() => () => void (state.at === "done" && URL.revokeObjectURL(state.url)), [state]);

  async function start() {
    const run = (stop.current = new AbortController());
    setState({ at: "running", done: 0, label: sources[0]?.label ?? "" });
    try {
      const { zip, rows } = await prepareAll(sources, clientName, limit, { signal: run.signal, progress: (done, label) => setState({ at: "running", done, label }) });
      await post(`/requests/${req.id}/export/ircc`, { files: rows.length, limit_mb: limit });
      setState({ at: "done", rows, url: URL.createObjectURL(zip) });
    } catch (e) {
      if (run.signal.aborted) onClose();
      else setState({ at: "failed" });
    }
  }

  const running = state.at === "running";
  const bad = state.at === "done" ? state.rows.filter((r) => !r.ok).length : 0;
  const zipName = `${words(req.title, 30) || "Request"}-IRCC.zip`;

  return (
    <dialog ref={ref} class="ircc" aria-labelledby="ircc-title" onCancel={onClose}>
      <h2 id="ircc-title">{t("ircc.title")}</h2>
      {(state.at === "idle" || state.at === "failed") && (
        <>
          <p>{t("ircc.intro")}</p>
          <p class="muted">{t("ircc.count", { items: total, files: sources.reduce((n, s) => n + s.files.length, 0) })}</p>
          <Field label={t("ircc.limit")} hint={t("ircc.limit_hint")}>
            <select value={limit} onChange={(e) => setLimit(Number(e.currentTarget.value))}>
              {LIMITS.map((n) => (
                <option value={n}>{t("ircc.limit_option", { n })}</option>
              ))}
            </select>
          </Field>
          {state.at === "failed" && <p class="error" role="alert">{t("ircc.failed")}</p>}
          <div class="actions">
            <button type="button" class="primary" onClick={start}>
              {t("ircc.start")}
            </button>
            <button type="button" onClick={onClose}>
              {t("cancel")}
            </button>
          </div>
        </>
      )}
      {running && (
        <>
          <p role="status">{t("ircc.progress", { n: Math.min(state.done + 1, total), total, label: state.label })}</p>
          <progress aria-label={t("ircc.progress_label")} value={state.done} max={total} />
          <div class="actions">
            <button type="button" onClick={() => stop.current?.abort()}>
              {t("cancel")}
            </button>
          </div>
        </>
      )}
      {state.at === "done" && (
        <>
          <p role="status">{bad ? t("ircc.done_check", { n: state.rows.length, bad }) : t("ircc.done", { n: state.rows.length })}</p>
          <table class="ircc-files">
            <thead>
              <tr>
                <th>{t("ircc.col_file")}</th>
                <th>{t("ircc.col_size")}</th>
                <th>{t("ircc.col_result")}</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((r) => (
                <tr>
                  <td>
                    {r.name}
                    <div class="sub">{r.item}</div>
                  </td>
                  <td>{fmtSize(r.size)}</td>
                  <td>
                    <Badge tone={r.ok ? "green" : "amber"}>{r.ok ? t("ircc.ok") : t("ircc.check")}</Badge>
                    {r.notes.map((n) => (
                      <div class="sub">{noteText(n)}</div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div class="actions">
            <a class="button primary" href={state.url} download={zipName}>
              {t("ircc.download")}
            </a>
            <button type="button" onClick={onClose}>
              {t("ircc.close")}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
