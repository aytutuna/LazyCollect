import { ZipWriter } from "./zip";

// "Prepare for IRCC": one PDF per checklist item that fits the portal's per-file limit.
// It runs in the browser, one item at a time, so the Worker only serves the files it already serves.

export const LIMITS = [2, 4, 5, 10];
export const DEFAULT_LIMIT = 4;

// 11 inches at 150 dpi: below this a scanned page stops being readable once printed
const MIN_EDGE = 1650;
const EDGES = [2400, 2000, MIN_EDGE];
const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45];
// room for the PDF's own structure around each image and for the file as a whole
const PER_PAGE = 3_000;
const PER_FILE = 4_000;
// IRCC counts megabytes; decimal ones are the smaller, so a file that fits stays under either
const MB = 1_000_000;

export type Encoded = { bytes: Uint8Array; width: number; height: number };
export type Decoded = { width: number; height: number; encode: (edge: number, quality: number) => Promise<Encoded>; close: () => void };
export type Decode = (blob: Blob) => Promise<Decoded>;

export type Input = { name: string; mime: string; blob: Blob };
export type Note = { code: "reduced" | "pdf_over" | "merged_over" | "images_over" | "unreadable" | "protected"; name?: string };
export type Output = { name: string; blob: Blob; size: number; ok: boolean; notes: Note[] };

export const limitBytes = (mb: number) => mb * MB;

// the first size and quality that fits the budget; otherwise the smallest one tried, marked as not fitting
export async function fitJpeg(image: Decoded, budget: number, signal?: AbortSignal): Promise<Encoded & { fits: boolean; reduced: boolean }> {
  const long = Math.max(image.width, image.height);
  const edges = [...new Set(EDGES.map((e) => Math.min(e, long)))];
  let last!: Encoded;
  for (const edge of edges) {
    for (const quality of QUALITIES) {
      signal?.throwIfAborted();
      last = await image.encode(edge, quality);
      if (last.bytes.length <= budget) return { ...last, fits: true, reduced: edge < edges[0] || quality < QUALITIES[0] };
      await new Promise((done) => setTimeout(done));
    }
  }
  return { ...last, fits: false, reduced: true };
}

const ascii = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "");

export const words = (s: string, max: number) => {
  const out: string[] = [];
  let len = 0;
  for (const w of ascii(s).split(/[^A-Za-z0-9]+/).filter(Boolean)) {
    if (len + w.length + (out.length ? 1 : 0) > max) {
      // one very long word is cut rather than dropped
      if (!out.length) out.push(w.slice(0, max));
      // a cut that ends on a joining word reads badly
      while (out.length > 1 && /^(and|or|of|the|for|to|a|in|on)$/i.test(out[out.length - 1])) out.pop();
      break;
    }
    len += w.length + (out.length ? 1 : 0);
    out.push(w);
  }
  return out.join("-");
};

// IRCC accepts letters, numbers, spaces and hyphens in a name, so words join with hyphens and everything else goes
export function irccName(label: string, fallbackPerson: string, taken: Set<string>): string {
  const [what, ...rest] = label.replace(/\([^)]*\)/g, " ").split(/\s+[—–-]\s+/);
  const base = words(what, 30) || "Document";
  const person = words(rest.join(" ") || fallbackPerson, 15);
  const stem = [base, person].filter(Boolean).join("-");
  let name = `${stem}.pdf`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}.pdf`;
  taken.add(name.toLowerCase());
  return name;
}

const ext = (name: string) => /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase() ?? "bin";

// a name not used yet in the zip, compared without regard to case; -2, -3 and so on keep the ones that collide apart
export function claim(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let out = name;
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${stem}-${n}${ext}`;
  taken.add(out.toLowerCase());
  return out;
}

const original = (stem: string, files: Input[], notes: Note[]): Output[] =>
  files.map((f, i) => {
    const base = stem.replace(/\.pdf$/, "");
    const name = files.length === 1 ? `${base}.${ext(f.name)}` : `${base}-${i + 1}.${ext(f.name)}`;
    return { name, blob: f.blob, size: f.blob.size, ok: false, notes };
  });

// All the files of one item as one PDF of at most `limit` bytes where that is possible.
// A file that can't be brought under the limit or read is passed on unchanged with a note saying why.
export async function buildItem(stem: string, files: Input[], limit: number, decode: Decode, signal?: AbortSignal): Promise<Output[]> {
  if (files.length === 1 && files[0].mime === "application/pdf") {
    const [f] = files;
    return f.blob.size <= limit ? [{ name: stem, blob: f.blob, size: f.blob.size, ok: true, notes: [] }] : original(stem, files, [{ code: "pdf_over" }]);
  }
  try {
    return await merge(stem, files, limit, decode, signal);
  } catch (e) {
    // one file that cannot be put together must not stop the rest; it goes through as it is
    if (signal?.aborted) throw e;
    return original(stem, files, [{ code: "unreadable" }]);
  }
}

async function merge(stem: string, files: Input[], limit: number, decode: Decode, signal?: AbortSignal): Promise<Output[]> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const notes: Note[] = [];
  const images = files.filter((f) => f.mime !== "application/pdf");
  const fixed = files.reduce((n, f) => n + (f.mime === "application/pdf" ? f.blob.size : 0), PER_FILE);
  let left = limit - fixed - images.length * PER_PAGE;
  let todo = images.length;
  let fell = false;
  for (const f of files) {
    signal?.throwIfAborted();
    if (f.mime === "application/pdf") {
      let src;
      try {
        src = await PDFDocument.load(await f.blob.arrayBuffer());
      } catch (e) {
        const locked = /encrypt/i.test(String(e));
        return original(stem, files, [{ code: locked ? "protected" : "unreadable", name: f.name }]);
      }
      for (const page of await doc.copyPages(src, src.getPageIndices())) doc.addPage(page);
      continue;
    }
    let image: Decoded;
    try {
      image = await decode(f.blob);
    } catch {
      return original(stem, files, [{ code: "unreadable", name: f.name }]);
    }
    try {
      const fit = await fitJpeg(image, Math.max(left / todo, 0), signal);
      todo--;
      left -= fit.bytes.length;
      fell ||= !fit.fits;
      if (fit.reduced && fit.fits && !notes.some((n) => n.code === "reduced")) notes.push({ code: "reduced" });
      const jpg = await doc.embedJpg(fit.bytes);
      const k = 792 / Math.max(fit.width, fit.height);
      const page = doc.addPage([fit.width * k, fit.height * k]);
      page.drawImage(jpg, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    } finally {
      image.close();
    }
  }
  const bytes = await doc.save();
  const over = bytes.length > limit;
  if (over) notes.push({ code: fell ? "images_over" : "merged_over" });
  return [{ name: stem, blob: new Blob([bytes as BlobPart], { type: "application/pdf" }), size: bytes.length, ok: !over, notes }];
}

// decodes in the browser; the canvas keeps the image's own orientation and gives transparent PNGs a white page
export async function decodeImage(blob: Blob): Promise<Decoded> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  return {
    width: bitmap.width,
    height: bitmap.height,
    async encode(edge, quality) {
      const k = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * k));
      canvas.height = Math.max(1, Math.round(bitmap.height * k));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const out = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", quality));
      if (!out) throw new Error("encode failed");
      return { bytes: new Uint8Array(await out.arrayBuffer()), width: canvas.width, height: canvas.height };
    },
    close() {
      bitmap.close();
      canvas.width = canvas.height = 0;
    },
  };
}

export type Source = { label: string; files: { id: string; name: string; mime: string }[] };

type ItemLike = { position: number; label: string; hidden: boolean; companion: string | null; for_pos: number | null; files: { id: string; name: string; mime: string; sent_back_at: number | null }[] };

// What goes to IRCC: answers and unfilled items have no files, a file sent back is not the one to send, and an item the
// client's answers hide is left out. A translation or affidavit is named after its original ("Passport translation — Amira Haddad").
export function irccSources(items: ItemLike[]): Source[] {
  const said = { translation: "translation", affidavit: "translator affidavit" } as const;
  return items
    .filter((i) => !i.hidden)
    .map((i) => {
      const kind = i.companion === "translation" || i.companion === "affidavit" ? said[i.companion] : null;
      const parent = kind && items.find((p) => p.position === i.for_pos);
      const [what, ...person] = parent ? parent.label.split(" — ") : [];
      return { label: parent ? [`${what} ${kind}`, ...person].join(" — ") : i.label, files: i.files.filter((f) => !f.sent_back_at) };
    })
    .filter((i) => i.files.length > 0);
}
export type Row = { item: string; name: string; size: number; ok: boolean; notes: Note[] };

// the file route allows 60 reads a minute per account, so a long request waits for the limit to clear
export async function fetchFile(id: string, signal: AbortSignal): Promise<Blob> {
  for (let tries = 0; ; tries++) {
    const res = await fetch(`/api/files/${id}`, { signal, credentials: "same-origin" });
    if (res.ok) return res.blob();
    if (res.status !== 429 || tries >= 6) throw new Error(`file ${res.status}`);
    await pause(10_000, signal);
  }
}

// a wait that ends at once when the person cancels
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    if (signal.aborted) return fail(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      done();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      fail(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

export async function prepareAll(
  items: Source[],
  person: string,
  limitMb: number,
  run: { signal: AbortSignal; progress: (done: number, label: string) => void; fetch?: typeof fetchFile; decode?: Decode },
): Promise<{ zip: Blob; rows: Row[] }> {
  const zip = new ZipWriter();
  const rows: Row[] = [];
  const taken = new Set<string>();
  for (const [at, item] of items.entries()) {
    run.progress(at, item.label);
    run.signal.throwIfAborted();
    const inputs: Input[] = [];
    for (const f of item.files) {
      run.signal.throwIfAborted();
      inputs.push({ name: f.name, mime: f.mime, blob: await (run.fetch ?? fetchFile)(f.id, run.signal) });
    }
    const stem = irccName(item.label, person, taken);
    const outputs = await buildItem(stem, inputs, limitBytes(limitMb), run.decode ?? decodeImage, run.signal);
    // the name the item reserved is released so that whatever comes out, a PDF or the files as they were, is claimed like any other
    taken.delete(stem.toLowerCase());
    for (const o of outputs) {
      const name = claim(o.name, taken);
      await zip.add(name, o.blob);
      rows.push({ item: item.label, name, size: o.size, ok: o.ok, notes: o.notes });
    }
    await new Promise((done) => setTimeout(done));
  }
  run.progress(items.length, "");
  return { zip: zip.finish(), rows };
}
