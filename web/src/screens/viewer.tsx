import { useEffect, useRef, useState } from "preact/hooks";
import { get } from "../api";
import { fmtSize } from "../format";
import { t } from "../i18n";
import type { FileRow, ItemWithFiles, RequestDetail } from "../types";
import { Badge, ErrorNote, Loading } from "../ui";
import { Review } from "./review";

const TONES = { empty: "grey", submitted: "teal", approved: "green", rejected: "red" };

// what the server will show inline; HEIC and the rest download instead
const VIEWABLE = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

function Preview({ file }: { file: FileRow }) {
  const url = `/api/files/${file.id}/view`;
  const viewable = VIEWABLE.includes(file.mime);
  const [state, setState] = useState<"checking" | "loading" | "ready" | "failed">("checking");
  const [error, setError] = useState<unknown>(null);

  // asked first, so a refusal is worded here instead of showing as raw text inside the frame
  useEffect(() => {
    if (!viewable) return;
    let live = true;
    get(`/files/${file.id}/view?check=1`).then(
      () => live && setState("loading"),
      (e) => live && (setError(e), setState("failed")),
    );
    return () => {
      live = false;
    };
  }, [file.id]);

  if (!viewable) return <p class="stage-note">{t("viewer.unsupported")}</p>;
  if (state === "failed") {
    return (
      <div class="stage-note">
        <ErrorNote error={error} />
        <p>{t("viewer.failed")}</p>
      </div>
    );
  }
  const shown = state === "ready";
  return (
    <>
      {!shown && <Loading />}
      {state !== "checking" &&
        (file.mime === "application/pdf" ? (
          <iframe class={shown ? "" : "pending"} title={t("viewer.alt", { name: file.name })} src={url} onLoad={() => setState("ready")} />
        ) : (
          <img class={shown ? "" : "pending"} alt={t("viewer.alt", { name: file.name })} src={url} onLoad={() => setState("ready")} onError={() => (setError(null), setState("failed"))} />
        ))}
    </>
  );
}

export function Viewer({ req, startId, onClose, onChanged }: { req: RequestDetail; startId: string; onClose: () => void; onChanged: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const entries = req.items.flatMap((item) => item.files.map((file) => ({ file, item })));
  const [id, setId] = useState(startId);
  const at = entries.findIndex((e) => e.file.id === id);

  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  // the file can go away while the page refreshes behind the viewer
  useEffect(() => {
    if (at < 0) onClose();
  }, [at]);
  if (at < 0) return null;

  const { file, item } = entries[at];
  const open = req.status === "open" || req.status === "complete";

  const move = (to: number) => entries[to] && setId(entries[to].file.id);
  function onKey(e: KeyboardEvent) {
    const typing = (e.target as HTMLElement).closest("input, textarea, select");
    if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft") move(at - 1);
    if (e.key === "ArrowRight") move(at + 1);
  }

  // a decision covers the whole item, so the next file shown is the first one of another item
  function decided() {
    onChanged();
    const next = entries.find((e, i) => i > at && e.item.id !== item.id);
    if (next) setId(next.file.id);
  }

  return (
    <dialog ref={ref} class="viewer" aria-labelledby="viewer-title" onCancel={onClose} onKeyDown={onKey}>
      <header>
        <div class="who">
          <h2 id="viewer-title">{item.label}</h2>
          <div class="muted">
            {file.name} ({fmtSize(file.size)})
          </div>
        </div>
        <Badge tone={TONES[item.status]}>{t(`item.${item.status}`)}</Badge>
        <button onClick={onClose}>{t("viewer.close")}</button>
      </header>
      <div class="stage">
        <Preview key={file.id} file={file} />
      </div>
      <footer>
        <nav aria-label={t("viewer.file_of", { n: at + 1, m: entries.length })}>
          <button disabled={at === 0} onClick={() => move(at - 1)}>
            {t("viewer.prev")}
          </button>
          <span role="status">{t("viewer.file_of", { n: at + 1, m: entries.length })}</span>
          <button disabled={at === entries.length - 1} onClick={() => move(at + 1)}>
            {t("viewer.next")}
          </button>
        </nav>
        <div class="decide">
          {open && item.status === "submitted" && <Review key={item.id} requestId={req.id} item={item as ItemWithFiles} onDone={decided} />}
          {item.status === "rejected" && item.reject_note && <p class="reject">{item.reject_note}</p>}
        </div>
        <div class="row-actions">
          {file.mime === "application/pdf" && (
            <a class="button" href={`/api/files/${file.id}/view`} target="_blank" rel="noopener">
              {t("viewer.new_tab")}
            </a>
          )}
          <a class="button" href={`/api/files/${file.id}`}>
            {t("viewer.download")}
          </a>
        </div>
        <p class="hint keys">{t("viewer.keys")}</p>
      </footer>
    </dialog>
  );
}
