import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import type { Prepared } from "../upload";
import { CameraView, type Capture } from "./CameraView";
import { CornerEditor } from "./CornerEditor";
import { acceptable } from "./corners";
import { Detector } from "./detector";
import { FILTERS, applyFilter, type Filter } from "./filters";
import { rotate, scaled, type Pixels, type Quad } from "./geometry";
import { draw, finalPage, flatPreview, pause, readPixels, release, shotOf, startQuad, toCanvas, type Shot } from "./pipeline";
import { frameIssues, pageIssues, type Issue } from "./quality";

type Page = {
  id: number;
  shot: Shot;
  quad: Quad;
  turns: number;
  filter: Filter;
  // the flat page, as photographed and as filtered, at preview size
  base: Pixels;
  shown: Pixels;
  thumb: string;
  issues: Issue[];
  accepted: boolean;
};

// a photo waiting for its corners to be placed; `replacing` is the page it will take the place of
type Draft = { shot: Shot; url: string; quad: Quad; confidence: number | null; replacing: number | null };

let seq = 0;

function thumbOf(img: Pixels): string {
  const full = toCanvas(img);
  const small = draw(full, img.width, img.height, 96).canvas;
  const url = small.toDataURL("image/jpeg", 0.7);
  release(full);
  release(small);
  return url;
}

function Preview({ img, label }: { img: Pixels; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext("2d")!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  }, [img]);
  return <canvas ref={ref} class="page-preview" role="img" aria-label={label} />;
}

export function Scanner({ label, onClose, onDone }: { label: string; onClose: () => void; onDone: (files: Prepared[]) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [detector] = useState(() => new Detector());
  const [step, setStep] = useState<"camera" | "nocamera" | "edit" | "review">("camera");
  const [why, setWhy] = useState<"denied" | "none" | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [at, setAt] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [working, setWorking] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // set once the scanner is closed, so work that is still running does not hand its pages on
  const gone = useRef(false);
  const [message, setMessage] = useState("");
  const page = pages[at];
  // where Add page and Retake lead back to
  const home = why ? "nocamera" : "camera";

  useEffect(() => {
    dialog.current!.showModal();
    return () => {
      gone.current = true;
      detector.close();
      dialog.current?.close();
    };
  }, []);
  const url = draft?.url;
  useEffect(() => (url ? () => URL.revokeObjectURL(url) : undefined), [url]);

  // spoken through the dialog's own polite region; the text is cleared first so a repeat is read again
  const say = (text: string) => {
    setMessage("");
    setTimeout(() => setMessage(text), 60);
  };

  // focus follows the step: the first corner handle, the page heading, the camera button, the discard prompt's safe button
  useEffect(() => {
    const target = { edit: ".handle", review: "#review-title", nocamera: ".no-camera button" }[step as string];
    if (target) dialog.current?.querySelector<HTMLElement>(target)?.focus();
  }, [step]);
  useEffect(() => {
    if (leaving) document.getElementById("leave-keep")?.focus();
  }, [leaving]);

  function close() {
    if (finishing) return;
    if (pages.length && !leaving) setLeaving(true);
    else onClose();
  }

  async function makePage(shot: Shot, quad: Quad, confidence: number | null, turns = 0, filter: Filter = "enhanced"): Promise<Page | null> {
    const base = await flatPreview(shot, quad, turns);
    if (!base) return null;
    const shown = applyFilter(base, filter);
    return { id: ++seq, shot, quad, turns, filter, base, shown, thumb: thumbOf(shown), issues: [...frameIssues(quad, confidence, shot.width, shot.height), ...pageIssues(base)], accepted: false };
  }

  // a new page, or the page being re-cut, from corners already placed
  async function place(shot: Shot, quad: Quad, confidence: number | null, replacing: number | null) {
    setWorking(t("scan.working"));
    const old = replacing === null ? null : pages[replacing];
    const made = await makePage(shot, quad, confidence, old?.turns ?? 0, old?.filter ?? "enhanced");
    setWorking("");
    if (!made) return edit(shot, startQuad(shot.width, shot.height), null, replacing);
    const index = replacing ?? pages.length;
    setPages(replacing === null ? [...pages, made] : pages.map((p, i) => (i === replacing ? made : p)));
    setAt(index);
    setDraft(null);
    setStep("review");
    say(t(made.issues.length ? "scan.page_issues" : "scan.page_added", { n: index + 1 }));
  }

  async function captured(c: Capture) {
    if (c.quad) return place(c.shot, c.quad, c.confidence, null);
    edit(c.shot, startQuad(c.shot.width, c.shot.height), null, null);
  }

  function edit(shot: Shot, quad: Quad, confidence: number | null, replacing: number | null) {
    setDraft({ shot, url: URL.createObjectURL(shot.blob), quad, confidence, replacing });
    setStep("edit");
    say(t("scan.edit_help"));
  }

  // a still photo from the system camera: the page is looked for in it, and the corners are placed by hand when it is not found
  async function photo(file: File) {
    setWorking(t("scan.working"));
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const shot = await shotOf(bitmap, bitmap.width, bitmap.height);
      const small = readPixels(bitmap, bitmap.width, bitmap.height, 800);
      bitmap.close();
      const found = await detector.detect({ ...small, data: small.data.slice() });
      setWorking("");
      if (found && acceptable(found, small.width, small.height)) return place(shot, scaled(found.quad, shot.width, shot.height), found.confidence, null);
      edit(shot, startQuad(shot.width, shot.height), null, null);
    } catch {
      setWorking("");
      setStep(home);
      say(t("scan.photo_failed"));
    }
  }

  function update(i: number, change: Partial<Page>) {
    setPages(pages.map((p, k) => (k === i ? { ...p, ...change } : p)));
  }

  function setFilter(filter: Filter) {
    const shown = applyFilter(page.base, filter);
    update(at, { filter, shown, thumb: thumbOf(shown) });
    say(t(`scan.filter_${filter}`));
  }

  function turn() {
    const base = rotate(page.base, 1);
    const shown = applyFilter(base, page.filter);
    update(at, { base, shown, thumb: thumbOf(shown), turns: (page.turns + 1) % 4 });
  }

  function remove() {
    const rest = pages.filter((_, i) => i !== at);
    setPages(rest);
    setAt(Math.max(0, Math.min(at, rest.length - 1)));
    if (!rest.length) setStep(home);
    say(t("scan.page_removed"));
  }

  function shift(by: number) {
    const to = at + by;
    const next = pages.slice();
    [next[at], next[to]] = [next[to], next[at]];
    setPages(next);
    setAt(to);
    say(t("scan.page_moved", { n: to + 1 }));
  }

  // Close and Esc do nothing while the pages are being prepared, and nothing is handed on once the scanner has gone.
  async function finish() {
    const files: Prepared[] = [];
    setFinishing(true);
    try {
      for (let i = 0; i < pages.length; i++) {
        setWorking(t("scan.preparing", { n: i + 1, m: pages.length }));
        const p = pages[i];
        const blob = await finalPage(p.shot, p.quad, p.turns, p.filter);
        if (gone.current) return;
        files.push({ blob, name: `${label}${pages.length > 1 ? ` ${i + 1}` : ""}.jpg`, jpeg: true });
        await pause();
        if (gone.current) return;
      }
    } catch {
      setWorking("");
      setFinishing(false);
      say(t("scan.photo_failed"));
      return;
    }
    onDone(files);
  }

  const unavailable = (reason: "denied" | "none") => {
    setWhy(reason);
    setStep("nocamera");
  };

  return (
    <dialog
      ref={dialog}
      class="scanner"
      aria-labelledby="scan-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header>
        <h2 id="scan-title">{t("scan.title", { label })}</h2>
        <button type="button" disabled={finishing} onClick={close}>
          {t("scan.close")}
        </button>
      </header>
      <div class="scan-body">
        {leaving && (
          <div class="callout" role="alertdialog" aria-labelledby="leave-title">
            <strong id="leave-title">{t("scan.discard", { n: pages.length })}</strong>
            <div class="row-actions">
              <button type="button" class="danger" onClick={onClose}>
                {t("scan.discard_yes")}
              </button>
              <button id="leave-keep" type="button" onClick={() => setLeaving(false)}>
                {t("scan.discard_no")}
              </button>
            </div>
          </div>
        )}

        {step === "camera" && <CameraView detector={detector} onCapture={captured} onUnavailable={unavailable} say={say} />}

        {step === "nocamera" && (
          <div class="no-camera">
            <p>{t(why === "denied" ? "scan.denied" : "scan.no_camera")}</p>
            <button type="button" class="primary" onClick={() => picker.current?.click()}>
              {t("scan.system_camera")}
            </button>
          </div>
        )}

        {step === "edit" && draft && (
          <>
            <p id="corner-help" class="hint">
              {t("scan.edit_help")}
            </p>
            <CornerEditor url={draft.url} width={draft.shot.width} height={draft.shot.height} quad={draft.quad} onChange={(quad) => setDraft({ ...draft, quad })} say={say} />
            <div class="row-actions">
              <button type="button" class="primary" onClick={() => place(draft.shot, draft.quad, draft.replacing === null ? draft.confidence : null, draft.replacing)}>
                {t("scan.use_corners")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setStep(draft.replacing === null ? home : "review");
                }}
              >
                {t(draft.replacing === null ? "scan.retake" : "scan.cancel")}
              </button>
            </div>
          </>
        )}

        {step === "review" && page && (
          <>
            <h3 id="review-title" tabIndex={-1} class="review-title">
              {t("scan.page_n", { n: at + 1, m: pages.length })}
            </h3>
            <Preview img={page.shown} label={t("scan.page_alt", { n: at + 1, m: pages.length, filter: t(`scan.filter_${page.filter}`) })} />
            {page.issues.length > 0 && !page.accepted && (
              <div class="callout notice" role="group" aria-labelledby="issues-title">
                <strong id="issues-title">{t("scan.issues_title")}</strong>
                <ul>
                  {page.issues.map((i) => (
                    <li key={i}>{t(`scan.issue_${i}`)}</li>
                  ))}
                </ul>
                <div class="row-actions">
                  <button type="button" onClick={remove}>
                    {t("scan.retake")}
                  </button>
                  <button type="button" onClick={() => update(at, { accepted: true })}>
                    {t("scan.use_anyway")}
                  </button>
                </div>
              </div>
            )}
            <fieldset class="filters">
              <legend>{t("scan.look")}</legend>
              {FILTERS.map((f) => (
                <label key={f} class="choice">
                  <input type="radio" name="filter" value={f} checked={page.filter === f} onChange={() => setFilter(f)} />
                  <span>{t(`scan.filter_${f}`)}</span>
                </label>
              ))}
            </fieldset>
            <div class="row-actions">
              <button type="button" onClick={() => edit(page.shot, page.quad, null, at)}>
                {t("scan.adjust")}
              </button>
              <button type="button" onClick={turn}>
                {t("scan.rotate")}
              </button>
            </div>
            <nav aria-label={t("scan.pages")}>
              <ol class="strip">
                {pages.map((p, i) => (
                  <li key={p.id}>
                    <button type="button" class="thumb" aria-current={i === at ? "true" : undefined} aria-label={t("scan.page_n", { n: i + 1, m: pages.length })} onClick={() => setAt(i)}>
                      <img src={p.thumb} alt="" />
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            <div class="row-actions">
              <button type="button" disabled={at === 0} onClick={() => shift(-1)}>
                {t("scan.earlier")}
              </button>
              <button type="button" disabled={at === pages.length - 1} onClick={() => shift(1)}>
                {t("scan.later")}
              </button>
              <button type="button" class="quiet" onClick={remove}>
                {t("scan.delete")}
              </button>
            </div>
            <div class="row-actions done">
              <button type="button" onClick={() => setStep(home)}>
                {t("scan.add")}
              </button>
              <button type="button" class="primary" disabled={finishing || Boolean(working)} onClick={finish}>
                {t("scan.done", { n: pages.length })}
              </button>
            </div>
          </>
        )}

        {working && <p class="muted">{working}</p>}
        <p class="sr-only" role="status">
          {message}
        </p>
        <input ref={picker} type="file" accept="image/*" capture="environment" hidden tabIndex={-1} onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) void photo(file);
        }} />
      </div>
    </dialog>
  );
}
