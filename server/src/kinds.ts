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
  [`${OFFICE}.wordprocessingml.document`]: ["docx"],
  [`${OFFICE}.presentationml.presentation`]: ["pptx"],
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
  { id: "excel", on: true, types: of("xlsx") },
  { id: "word", on: true, types: of("docx") },
  { id: "csv", on: true, types: of("csv") },
  { id: "powerpoint", on: false, types: of("pptx") },
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

// what one file may inflate to in all, nested packages included
const INFLATE_CAP = 16 << 20;
const MAX_PARTS = 3000;
const MAX_RELS = 200;
const MAX_DEPTH = 2;

type Budget = { left: number };

// a part's bytes, inflated against the shared budget; null when it is damaged or would use up the budget
async function inflate(b: Uint8Array, e: Entry, budget: Budget): Promise<Uint8Array | null> {
  if (e.at + 30 > b.length || u32(b, e.at) !== 0x04034b50) return null;
  const start = e.at + 30 + u16(b, e.at + 26) + u16(b, e.at + 28);
  if (start > b.length) return null;
  const data = b.subarray(start, start + e.packed);
  if (e.method === 0) {
    if (data.length > budget.left) return null;
    budget.left -= data.length;
    return data;
  }
  if (e.method !== 8) return null;
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > budget.left) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  budget.left -= total;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// the first few bytes of a part, without inflating the rest
async function head(b: Uint8Array, e: Entry): Promise<Uint8Array | null> {
  if (e.at + 30 > b.length || u32(b, e.at) !== 0x04034b50) return null;
  const start = e.at + 30 + u16(b, e.at + 26) + u16(b, e.at + 28);
  if (start > b.length) return null;
  const data = b.subarray(start, start + e.packed);
  if (e.method === 0) return data.subarray(0, 8);
  if (e.method !== 8) return null;
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  try {
    const { value } = await reader.read();
    await reader.cancel();
    return value ? value.subarray(0, 8) : new Uint8Array();
  } catch {
    return null;
  }
}

// xml as it was saved, in UTF-8 or in UTF-16 of either order, with character references decoded so a letter can't hide in one
function xmlText(bytes: Uint8Array): string {
  let label = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
  else if (bytes[0] === 0 && bytes[1] !== 0) label = "utf-16be";
  else if (bytes[1] === 0 && bytes[0] !== 0) label = "utf-16le";
  return new TextDecoder(label).decode(bytes).replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) => {
    const n = hex ? parseInt(hex, 16) : Number(dec);
    return n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });
}

// parts that carry or can start code
const MACRO_PART = /(^|\/)vbaProject\.bin$|(^|\/)vbaData\.xml$|^xl\/macrosheets\/|^xl\/dialogsheets\/|(^|\/)activeX\//i;
// in the content types and the relationships: macro-enabled documents, VBA projects, ActiveX controls and embedded OLE objects
const MACRO_TYPE = /macroEnabled|vbaProject|vbaData|activeX|oleObject|macrosheet/i;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (b: Uint8Array, magic: number[]) => magic.every((x, i) => b[i] === x);

// A zip package, and everything inside it: macro and ActiveX parts and types are refused, a part that is an old compound file is
// refused, and a part that is itself a package (a chart's workbook) has to pass the same check. "macros" for any of those, null
// when something can't be read, which is refused too.
async function inZip(b: Uint8Array, depth = 0, budget: Budget = { left: INFLATE_CAP }): Promise<string | "macros" | null> {
  const entries = zipEntries(b);
  if (!entries || entries.length > MAX_PARTS) return null;
  const names = new Set(entries.map((e) => e.name));
  const first = entries[0];
  let mime: string | null = null;
  if (first?.name === "mimetype" && first.method === 0) {
    const kind = xmlText((await inflate(b, first, budget)) ?? new Uint8Array()).trim();
    mime = Object.keys(TYPES).find((m) => m.startsWith(ODF) && m === kind) ?? null;
    if (!mime) return null;
    if (entries.some((e) => /^(Basic|Scripts|Dialogs)\//.test(e.name))) return "macros";
  } else {
    const types = entries.find((e) => e.name === "[Content_Types].xml");
    if (!types) return null;
    if (names.has("xl/workbook.xml")) mime = `${OFFICE}.spreadsheetml.sheet`;
    else if (names.has("word/document.xml")) mime = `${OFFICE}.wordprocessingml.document`;
    else if (names.has("ppt/presentation.xml")) mime = `${OFFICE}.presentationml.presentation`;
    if (!mime) return null;
    if (entries.some((e) => MACRO_PART.test(e.name))) return "macros";
    // a part can be renamed, so the content types and every relationship are read for what they say each part is
    const rels = entries.filter((e) => /\.rels$/i.test(e.name));
    if (rels.length > MAX_RELS) return null;
    for (const e of [types, ...rels]) {
      const bytes = await inflate(b, e, budget);
      if (!bytes) return null;
      if (MACRO_TYPE.test(xmlText(bytes))) return "macros";
    }
  }
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    const start = await head(b, e);
    if (!start) return null;
    if (startsWith(start, OLE_MAGIC)) return "macros";
    if (start[0] === 0x50 && start[1] === 0x4b && start[2] === 3 && start[3] === 4) {
      if (depth >= MAX_DEPTH) return null;
      const inner = await inflate(b, e, budget);
      if (!inner) return null;
      const found = await inZip(inner, depth + 1, budget);
      if (!found || found === "macros") return found;
    }
  }
  return mime;
}

// readable text: no control characters but tab and line breaks, in whatever 8-bit or UTF-8 coding it was saved
const readable = (b: Uint8Array) => b.every((x) => x === 9 || x === 10 || x === 13 || (x >= 32 && x !== 127));

// which way a file that isn't a PDF or a picture has to be read, from its first bytes and its name; "old" for a compound file,
// the format of Word, Excel and PowerPoint before 2007, which is not taken at all
export function familyOf(first: Uint8Array, name: string): "zip" | "old" | "text" | null {
  if (first[0] === 0x50 && first[1] === 0x4b && first[2] === 3 && first[3] === 4) return "zip";
  if (startsWith(first, OLE_MAGIC)) return "old";
  if (/\.(csv|tsv|txt)$/i.test(name) && readable(first)) return "text";
  return null;
}

// the type of the whole file, "macros" when it can run code, null when it is none of the kinds
export async function inspect(family: "zip" | "text", whole: Uint8Array, name: string): Promise<string | "macros" | null> {
  if (family === "zip") return inZip(whole);
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
