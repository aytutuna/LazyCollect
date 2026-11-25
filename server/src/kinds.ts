import { Hono } from "hono";
import { audit } from "./audit";
import { isOwner } from "./firm";
import type { AppEnv } from "./session";
import { invalid, readBody } from "./validate";

// What an account may take, picked by its owner. Each file is looked at by its first bytes and the type found there decides the kind;
// the name only tells a CSV from a plain text file, which look the same.
const OFFICE = "application/vnd.openxmlformats-officedocument";
const ODF = "application/vnd.oasis.opendocument";

export const TYPES: Record<string, string[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/heic": ["heic", "heif"],
  "image/heif": ["heif", "heic"],
  [`${OFFICE}.spreadsheetml.sheet`]: ["xlsx"],
  "application/vnd.ms-excel": ["xls"],
  [`${OFFICE}.wordprocessingml.document`]: ["docx"],
  "application/msword": ["doc"],
  [`${OFFICE}.presentationml.presentation`]: ["pptx"],
  "application/vnd.ms-powerpoint": ["ppt"],
  [`${ODF}.text`]: ["odt"],
  [`${ODF}.spreadsheet`]: ["ods"],
  [`${ODF}.presentation`]: ["odp"],
  "text/csv": ["csv", "tsv"],
  "text/plain": ["txt"],
};

export type Kind = { id: string; on: boolean; types: string[] };

const of = (...exts: string[]) => Object.keys(TYPES).filter((m) => exts.includes(TYPES[m][0]));

export const KINDS: Kind[] = [
  { id: "pdf", on: true, types: of("pdf") },
  { id: "pictures", on: true, types: of("jpg", "png", "webp", "heic", "heif") },
  { id: "excel", on: true, types: of("xlsx", "xls") },
  { id: "word", on: true, types: of("docx", "doc") },
  { id: "csv", on: true, types: of("csv") },
  { id: "powerpoint", on: false, types: of("pptx", "ppt") },
  { id: "opendocument", on: false, types: of("odt", "ods", "odp") },
  { id: "text", on: false, types: of("txt") },
];

const ids = new Set(KINDS.map((k) => k.id));
const DEFAULTS = KINDS.filter((k) => k.on).map((k) => k.id);

export const kindOf = (mime: string) => KINDS.find((k) => k.types.includes(mime))?.id;

export function parseKinds(stored: string | null | undefined): string[] {
  if (!stored) return DEFAULTS;
  try {
    const list = JSON.parse(stored);
    return Array.isArray(list) ? list.filter((k) => typeof k === "string" && ids.has(k)) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

// the extensions and types a file picker can offer for these kinds
export const acceptFor = (kinds: string[]) => KINDS.filter((k) => kinds.includes(k.id)).flatMap((k) => k.types.flatMap((m) => [m, ...TYPES[m].map((e) => `.${e}`)]));

// ---- looking inside a file ----

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

type Entry = { name: string; method: number; packed: number; size: number; at: number };

// the file names of a zip, from its central directory; null when that is missing or damaged
function zipEntries(b: Uint8Array): Entry[] | null {
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = u16(b, end + 10);
  let at = u32(b, end + 16);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > b.length || u32(b, at) !== 0x02014b50) return null;
    const n = u16(b, at + 28);
    const next = at + 46 + n + u16(b, at + 30) + u16(b, at + 32);
    if (next > b.length) return null;
    out.push({ name: new TextDecoder().decode(b.subarray(at + 46, at + 46 + n)), method: u16(b, at + 10), packed: u32(b, at + 20), size: u32(b, at + 24), at: u32(b, at + 42) });
    at = next;
  }
  return out;
}

const SMALL = 1 << 20;

// one small entry, inflated with a cap so a hostile size can't use up memory
async function zipText(b: Uint8Array, e: Entry): Promise<string | null> {
  if (e.at + 30 > b.length || u32(b, e.at) !== 0x04034b50) return null;
  const start = e.at + 30 + u16(b, e.at + 26) + u16(b, e.at + 28);
  if (start > b.length) return null;
  const data = b.subarray(start, start + e.packed);
  if (e.method === 0) return new TextDecoder().decode(data.subarray(0, Math.min(e.size, SMALL)));
  if (e.method !== 8) return null;
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > SMALL) {
        await reader.cancel();
        break;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
}

// parts that carry or can start code, and what an Office file may bring along (embedded workbooks and objects, ActiveX)
const MACRO_PART = /(^|\/)vbaProject\.bin$|(^|\/)vbaData\.xml$|^xl\/macrosheets\/|^xl\/dialogsheets\/|(^|\/)(embeddings|activeX)\//i;
// in the content types and the relationships: macro-enabled documents, VBA projects, ActiveX controls and embedded objects
const MACRO_TYPE = /macroEnabled|vbaProject|vbaData|activeX|oleObject|macrosheet|relationships\/package"/i;
const MAX_RELS = 200;

async function inZip(b: Uint8Array): Promise<string | "macros" | null> {
  const entries = zipEntries(b);
  if (!entries) return null;
  const names = new Set(entries.map((e) => e.name));
  const first = entries[0];
  if (first?.name === "mimetype" && first.method === 0) {
    const kind = (await zipText(b, first))?.trim() ?? "";
    const mime = Object.keys(TYPES).find((m) => m.startsWith(ODF) && m === kind);
    if (!mime) return null;
    return entries.some((e) => /^(Basic|Scripts|Dialogs)\//.test(e.name)) ? "macros" : mime;
  }
  const types = entries.find((e) => e.name === "[Content_Types].xml");
  if (!types) return null;
  if (entries.some((e) => MACRO_PART.test(e.name))) return "macros";
  // a part can be renamed, so the content types and every relationship are read for what they say each part is
  const rels = entries.filter((e) => e.name.endsWith(".rels"));
  if (rels.length > MAX_RELS) return null;
  for (const e of [types, ...rels]) {
    if (MACRO_TYPE.test((await zipText(b, e)) ?? "")) return "macros";
  }
  if (names.has("xl/workbook.xml")) return `${OFFICE}.spreadsheetml.sheet`;
  if (names.has("word/document.xml")) return `${OFFICE}.wordprocessingml.document`;
  if (names.has("ppt/presentation.xml")) return `${OFFICE}.presentationml.presentation`;
  return null;
}

type OleEntry = { name: string; type: number; start: number; size: number };
type Ole = { b: Uint8Array; size: number; fat: number[]; entries: OleEntry[] };

const LAST = 0xfffffffa;

// A compound file (the old .xls, .doc and .ppt), as far as its directory. Every walk is bounded by the number of sectors the
// file really has, so a padded or looping table ends instead of running on; null when it can't be read.
export function oleOpen(b: Uint8Array): Ole | null {
  if (b.length < 512 || ascii(b, 0, 8) !== "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") return null;
  const shift = u16(b, 0x1e);
  if (shift !== 9 && shift !== 12) return null;
  const size = 1 << shift;
  const sectors = Math.floor(b.length / size);
  const at = (id: number) => (id + 1) * size;
  const inside = (id: number) => id < sectors && at(id) + size <= b.length;
  const numFat = u32(b, 0x2c);
  if (numFat > sectors) return null;
  const fatIds: number[] = [];
  for (let i = 0; i < 109; i++) fatIds.push(u32(b, 0x4c + i * 4));
  const seen = new Set<number>();
  let difat = u32(b, 0x44);
  for (let n = Math.min(u32(b, 0x48), sectors); n > 0 && difat < LAST; n--) {
    if (!inside(difat) || seen.has(difat)) return null;
    seen.add(difat);
    for (let i = 0; i < size / 4 - 1; i++) fatIds.push(u32(b, at(difat) + i * 4));
    difat = u32(b, at(difat) + size - 4);
  }
  const fat: number[] = [];
  for (const id of fatIds.slice(0, numFat)) {
    if (!inside(id)) return null;
    for (let i = 0; i < size / 4; i++) fat.push(u32(b, at(id) + i * 4));
  }
  const entries: OleEntry[] = [];
  let sector = u32(b, 0x30);
  for (let hops = 0; sector < LAST; hops++) {
    if (hops > sectors || !inside(sector)) return null;
    for (let e = at(sector); e < at(sector) + size; e += 128) {
      const type = b[e + 66];
      const len = u16(b, e + 64);
      if ((type === 1 || type === 2 || type === 5) && len >= 2 && len <= 64) {
        entries.push({ name: new TextDecoder("utf-16le").decode(b.subarray(e, e + len - 2)), type, start: u32(b, e + 116), size: u32(b, e + 120) });
      }
    }
    sector = fat[sector] ?? LAST;
  }
  return entries.length ? { b, size, fat, entries } : null;
}

// a chain of sectors, never longer than the table can hold
function chain(start: number, next: number[], limit: number): number[] | null {
  const out: number[] = [];
  for (let id = start; id < LAST; id = next[id] ?? LAST) {
    if (out.length >= limit) return null;
    out.push(id);
  }
  return out;
}

function stream(o: Ole, e: OleEntry): Uint8Array | null {
  const { b, size, fat } = o;
  const sectors = Math.floor(b.length / size);
  const regular = (start: number, length: number) => {
    const ids = chain(start, fat, sectors);
    if (!ids || ids.some((id) => id >= sectors) || ids.length * size < length) return null;
    const out = new Uint8Array(length);
    ids.forEach((id, i) => out.set(b.subarray((id + 1) * size, (id + 2) * size).subarray(0, Math.max(0, Math.min(size, length - i * size))), i * size));
    return out;
  };
  if (e.size >= 4096) return regular(e.start, e.size);
  // a short stream lives in the mini stream, 64-byte pieces inside the root's own stream
  const root = o.entries.find((x) => x.type === 5);
  if (!root || root.size > b.length) return null;
  const container = regular(root.start, root.size);
  const table = regular(u32(b, 0x3c), u32(b, 0x40) * size);
  if (!container || !table) return null;
  const mini = Array.from({ length: table.length / 4 }, (_, i) => u32(table, i * 4));
  const ids = chain(e.start, mini, mini.length);
  if (!ids || ids.length * 64 < e.size) return null;
  const out = new Uint8Array(e.size);
  ids.forEach((id, i) => out.set(container.subarray(id * 64, id * 64 + 64).subarray(0, Math.max(0, Math.min(64, e.size - i * 64))), i * 64));
  return out;
}

// Excel 4.0 (XLM) macros live in sheets of the macro kind, listed in the workbook's first stretch of records
function hasMacroSheet(book: Uint8Array): boolean {
  for (let at = 0; at + 4 <= book.length; ) {
    const type = u16(book, at);
    const length = u16(book, at + 2);
    if (type === 0x000a) return false;
    // BOUNDSHEET: the sheet's kind is the second byte after the 4-byte position; 1 is a macro sheet and 6 a VBA module
    if (type === 0x0085 && length >= 6 && [1, 6].includes(book[at + 4 + 5] & 0x0f)) return true;
    at += 4 + length;
  }
  return false;
}

// Old Office files are only taken when nothing in them can be shown to run code: no VBA storage whatever its case, no macro
// sheet, and a workbook that can be read through to prove it.
function inOle(b: Uint8Array): string | "macros" | null {
  const o = oleOpen(b);
  if (!o) return null;
  const names = o.entries.map((e) => e.name.toLowerCase());
  if (names.some((n) => n === "vba" || n === "macros" || n.startsWith("_vba_project") || n === "_macrostorage" || n === "xlm")) return "macros";
  const book = o.entries.find((e) => e.type === 2 && (e.name === "Workbook" || e.name === "Book"));
  if (book) {
    const data = stream(o, book);
    return !data || hasMacroSheet(data) ? "macros" : "application/vnd.ms-excel";
  }
  if (names.includes("worddocument")) return "application/msword";
  if (names.includes("powerpoint document")) return "application/vnd.ms-powerpoint";
  return null;
}

// readable text: no control characters but tab and line breaks, in whatever 8-bit or UTF-8 coding it was saved
const readable = (b: Uint8Array) => b.every((x) => x === 9 || x === 10 || x === 13 || (x >= 32 && x !== 127));

export const MAGIC = { zip: "PK\x03\x04", ole: "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" };

// which way a file that isn't a PDF or a picture has to be read, from its first bytes and its name
export function familyOf(first: Uint8Array, name: string): "zip" | "ole" | "text" | null {
  if (ascii(first, 0, 4) === MAGIC.zip) return "zip";
  if (ascii(first, 0, 8) === MAGIC.ole) return "ole";
  if (/\.(csv|tsv|txt)$/i.test(name) && readable(first)) return "text";
  return null;
}

// the type of the whole file, "macros" when it can run code, null when it is none of the kinds
export async function inspect(family: "zip" | "ole" | "text", whole: Uint8Array, name: string): Promise<string | "macros" | null> {
  if (family === "zip") return inZip(whole);
  if (family === "ole") return inOle(whole);
  if (!readable(whole)) return null;
  return /\.txt$/i.test(name) ? "text/plain" : "text/csv";
}

export const kinds = new Hono<AppEnv>();

kinds.get("/file-kinds", async (c) => {
  const row = await c.get("db").prepare("SELECT file_kinds FROM firm_settings WHERE firm_id = ?").bind(c.get("firm").id).first<{ file_kinds: string | null }>();
  const on = parseKinds(row?.file_kinds);
  return c.json({
    kinds: KINDS.map((k) => ({ id: k.id, on: on.includes(k.id), suggested: k.on, extensions: k.types.map((m) => TYPES[m][0]) })),
  });
});

kinds.put("/file-kinds", async (c) => {
  if (!(await isOwner(c))) return c.json({ error: "forbidden" }, 403);
  const list = (await readBody(c))?.kinds;
  if (!Array.isArray(list) || !list.length || list.some((k) => typeof k !== "string" || !ids.has(k))) return invalid(c);
  const picked = KINDS.map((k) => k.id).filter((id) => list.includes(id));
  const db = c.get("db");
  const firmId = c.get("firm").id;
  await db.batch([
    db.prepare("INSERT INTO firm_settings (firm_id, file_kinds) VALUES (?, ?) ON CONFLICT (firm_id) DO UPDATE SET file_kinds = excluded.file_kinds").bind(firmId, JSON.stringify(picked)),
    audit(c, "filekinds.update", "firm", firmId, { kinds: picked }),
  ]);
  return c.json({ kinds: picked });
});
