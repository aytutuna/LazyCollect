import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, post } from "../api";
import { fmtSize } from "../format";
import { t } from "../i18n";
import { DEFAULT_LIMIT, LIMITS, irccSources, pause, prepareAll, words, type Note, type Row } from "../ircc";
import type { RequestDetail } from "../types";
import { Badge, Field } from "../ui";

type State = { at: "idle" } | { at: "running"; done: number; label: string } | { at: "done"; rows: Row[]; url: string; logged: boolean } | { at: "failed" };

const noteText = (n: Note) => t(n.code === "unreadable" && !n.name ? "ircc.note.unreadable_item" : `ircc.note.${n.code}`, { name: n.name ?? "" });

// the export is logged once it is made; a busy limit is waited out a few times, and the files are kept whatever happens
async function log(path: string, body: unknown, signal: AbortSignal): Promise<boolean> {
  for (let tries = 0; tries < 4; tries++) {
    try {
      await post(path, body);
      return true;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 429)) return false;
      await pause(3_000, signal);
    }
  }
  return false;
}

export function IrccDialog({ req, clientName, onClose }: { req: RequestDetail; clientName: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const stop = useRef<AbortController | undefined>(undefined);
  const cancel = useRef<HTMLButtonElement>(null);
  const download = useRef<HTMLAnchorElement>(null);
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
  // focus follows the work: Cancel while it runs, Download once there is something to download
  useEffect(() => {
    if (state.at === "running") cancel.current?.focus();
    if (state.at === "done") download.current?.focus();
  }, [state.at]);

  async function start() {
    const run = (stop.current = new AbortController());
    setState({ at: "running", done: 0, label: sources[0]?.label ?? "" });
    try {
      const { zip, rows } = await prepareAll(sources, clientName, limit, { signal: run.signal, progress: (done, label) => setState({ at: "running", done, label }) });
      const logged = await log(`/requests/${req.id}/export/ircc`, { files: rows.length, limit_mb: limit }, run.signal);
      setState({ at: "done", rows, url: URL.createObjectURL(zip), logged });
    } catch (e) {
      if (run.signal.aborted) onClose();
      else setState({ at: "failed" });
    }
  }

  const running = state.at === "running";
  const bad = state.at === "done" ? state.rows.filter((r) => !r.ok).length : 0;
  const say =
    state.at === "running"
      ? t("ircc.progress", { n: Math.min(state.done + 1, total), total, label: state.label })
      : state.at === "done"
        ? bad
          ? t("ircc.done_check", { n: state.rows.length, bad })
          : t("ircc.done", { n: state.rows.length })
        : state.at === "failed"
          ? t("ircc.failed")
          : "";
  const zipName = `${words(req.title, 30) || "Request"}-IRCC.zip`;

  return (
    <dialog ref={ref} class="ircc" aria-labelledby="ircc-title" onCancel={onClose}>
      <h2 id="ircc-title">{t("ircc.title")}</h2>
      <p class="sr-only" role="status">
        {say}
      </p>
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
          {total === 0 && <p class="muted">{t("ircc.nothing")}</p>}
          {state.at === "failed" && <p class="error">{t("ircc.failed")}</p>}
          <div class="actions">
            <button type="button" class="primary" disabled={total === 0} onClick={start}>
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
          <p>{t("ircc.progress", { n: Math.min(state.done + 1, total), total, label: state.label })}</p>
          <progress aria-label={t("ircc.progress_label")} value={state.done} max={total} />
          <div class="actions">
            <button type="button" ref={cancel} onClick={() => stop.current?.abort()}>
              {t("cancel")}
            </button>
          </div>
        </>
      )}
      {state.at === "done" && (
        <>
          <p>{bad ? t("ircc.done_check", { n: state.rows.length, bad }) : t("ircc.done", { n: state.rows.length })}</p>
          {!state.logged && <p class="muted">{t("ircc.not_logged")}</p>}
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
            <a class="button primary" ref={download} href={state.url} download={zipName}>
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
