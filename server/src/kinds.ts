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

type Entry = { name: string; flags: number; method: number; packed: number; size: number; at: number; data: number };

// Limits for looking at one upload: parts in all (every level counted), the xml read, the bytes of nested packages held at once,
// and everything inflated.
type Budget = { parts: number; xml: number; alive: number; out: number };
const newBudget = (): Budget => ({ parts: 3000, xml: 4 << 20, alive: 12 << 20, out: 64 << 20 });
const XML_PART = 2 << 20;
const MAX_DEPTH = 2;

const EOCD = 0x06054b50;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const goodName = (name: string) => {
  if (!name || name.startsWith("/") || /[\\\0%]/.test(name)) return false;
  return name.replace(/\/$/, "").split("/").every((s) => s !== "" && s !== "." && s !== "..");
};

// A zip read strictly: the end record is the last 22 bytes, the central directory fills exactly the space before it, every entry
// has the same name, method and sizes in its local header, no two entries share or overlap their bytes, and no name is ambiguous.
// null for anything else, since two readers that disagree about a file are how a macro gets past a check.
function readZip(b: Uint8Array, budget: Budget): Entry[] | null {
  const end = b.length - 22;
  if (end < 0 || u32(b, end) !== EOCD || u16(b, end + 20) !== 0) return null;
  if (end >= 20 && u32(b, end - 20) === 0x07064b50) return null;
  const count = u16(b, end + 10);
  const cdSize = u32(b, end + 12);
  const cdAt = u32(b, end + 16);
  if (u16(b, end + 4) !== 0 || u16(b, end + 6) !== 0 || u16(b, end + 8) !== count || count === 0 || count === 0xffff) return null;
  if (cdSize === 0xffffffff || cdAt === 0xffffffff || cdAt + cdSize !== end) return null;
  if ((budget.parts -= count) < 0) return null;
  const out: Entry[] = [];
  const seen = new Set<string>();
  let at = cdAt;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(b, at) !== 0x02014b50) return null;
    const flags = u16(b, at + 8);
    const method = u16(b, at + 10);
    const packed = u32(b, at + 20);
    const size = u32(b, at + 24);
    const n = u16(b, at + 28);
    const next = at + 46 + n + u16(b, at + 30) + u16(b, at + 32);
    const local = u32(b, at + 42);
    if (next > end || u16(b, at + 34) !== 0 || flags & 0x41 || (method !== 0 && method !== 8)) return null;
    if (packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff || (method === 0 && packed !== size)) return null;
    let name: string;
    try {
      name = decoder.decode(b.subarray(at + 46, at + 46 + n));
    } catch {
      return null;
    }
    const key = name.normalize("NFKC").toLowerCase();
    if (!goodName(name) || seen.has(key)) return null;
    seen.add(key);
    // the local header says the same thing as the central one
    if (local + 30 > cdAt || u32(b, local) !== 0x04034b50 || u16(b, local + 6) !== flags || u16(b, local + 8) !== method) return null;
    const ln = u16(b, local + 26);
    const data = local + 30 + ln + u16(b, local + 28);
    if (ln !== n || data + packed > cdAt) return null;
    for (let j = 0; j < n; j++) if (b[local + 30 + j] !== b[at + 46 + j]) return null;
    if (!(flags & 8) && (u32(b, local + 18) !== packed || u32(b, local + 22) !== size)) return null;
    out.push({ name, flags, method, packed, size, at: local, data });
    at = next;
  }
  if (at !== end) return null;
  const sorted = [...out].sort((x, y) => x.at - y.at);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].at < sorted[i - 1].data + sorted[i - 1].packed) return null;
  return out;
}

// Inflates into a buffer of `want` bytes. The compressed bytes are fed in small slices and the output is counted as it comes, so
// a bomb stops at the cap instead of being unpacked whole. With exact, the part has to inflate to exactly `want` bytes; without it
// the first `want` bytes are taken and the rest is left.
async function inflate(data: Uint8Array, want: number, exact: boolean, slice = 4096): Promise<Uint8Array | null> {
  const out = new Uint8Array(want);
  let got = 0;
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const feed = (async () => {
    for (let i = 0; i < data.length; i += slice) {
      await writer.ready;
      await writer.write(data.subarray(i, i + slice));
    }
    await writer.close();
  })().catch(() => {});
  let ok = true;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (got + value.length > want) {
        if (exact) ok = false;
        else {
          out.set(value.subarray(0, want - got), got);
          got = want;
        }
        await reader.cancel().catch(() => {});
        break;
      }
      out.set(value, got);
      got += value.length;
      if (!exact && got === want) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    ok = false;
  }
  await feed;
  return ok && (!exact || got === want) ? out.subarray(0, got) : null;
}

// a part's whole content, charged to the inflate budget and held to `max`
async function bytesOf(b: Uint8Array, e: Entry, max: number, budget: Budget): Promise<Uint8Array | null> {
  if (e.size > max || (budget.out -= e.size) < 0) return null;
  const data = b.subarray(e.data, e.data + e.packed);
  return e.method === 0 ? data : inflate(data, e.size, true);
}

// the first few bytes of a part, without unpacking the rest
async function head(b: Uint8Array, e: Entry): Promise<Uint8Array | null> {
  const data = b.subarray(e.data, e.data + e.packed);
  if (e.method === 0) return data.subarray(0, 8);
  return inflate(data, Math.min(8, e.size), false, 256);
}

// xml as saved, in UTF-8 or in UTF-16 of either order, with character references decoded and look-alike letters folded, so
// nothing can hide in how it was written; null for what a reader could take more than one way
function xmlText(bytes: Uint8Array): string | null {
  let label = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
  else if (bytes[0] === 0 && bytes[1] !== 0) label = "utf-16be";
  else if (bytes[1] === 0 && bytes[0] !== 0) label = "utf-16le";
  let text: string;
  try {
    text = new TextDecoder(label, { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  const declared = /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(text)?.[1];
  if (text.includes("\0") || /<!DOCTYPE/i.test(text) || (declared && !/^utf-?(8|16)(le|be)?$/i.test(declared))) return null;
  return text
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) => {
      const n = hex ? parseInt(hex, 16) : Number(dec);
      return n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .normalize("NFKC");
}

// parts that carry or can start code
const MACRO_PART = /(^|\/)vbaProject\.bin$|(^|\/)vbaData\.xml$|^xl\/macrosheets\/|^xl\/dialogsheets\/|(^|\/)activeX\/|(^|\/)afchunk/iu;
// in the content types and the relationships: macro-enabled documents, VBA projects, ActiveX controls, embedded OLE objects and
// included chunks
const MACRO_TYPE = /macroEnabled|vbaProject|vbaData|activeX|oleObject|macrosheet|xlMacro|aFChunk/iu;
// relationships that fetch a template, a sub-document or a frame from where the target points
const FETCHING = /\/(attachedTemplate|subDocument|frame)$/iu;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (b: Uint8Array, magic: number[]) => magic.every((x, i) => b[i] === x);

const remote = (target: string) => /^(https?|ftp):/iu.test(target.trim()) || /^(\\\\|\/\/)/u.test(target.trim()) || /^file:\/\/[^/]/iu.test(target.trim());

// a relationships part that names a macro, ActiveX control or embedded object, or fetches something from elsewhere
function badRels(text: string): boolean {
  if (MACRO_TYPE.test(text)) return true;
  for (const tag of text.match(/<Relationship\b[^>]*>/giu) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "iu").exec(tag);
    const type = attr("Type");
    const target = attr("Target");
    if (type && target && FETCHING.test(type[1] ?? type[2]) && remote(target[1] ?? target[2])) return true;
  }
  return false;
}

type Verdict = { v: "ok"; mime: string | null } | { v: "macros" } | { v: "bad" };
const BAD: Verdict = { v: "bad" };
const MACROS: Verdict = { v: "macros" };

// A zip package, and everything inside it. Macro, ActiveX and DDE parts and types are refused, so are relationships that fetch from
// elsewhere, a part that is an old compound file, and a package that claims to be two formats. A part that is itself a package (a
// chart's workbook) is checked the same way, down to two levels; one that is not a Word, Excel, PowerPoint or OpenDocument file is
// only held to the macro checks. At the top level the package has to be one of those four.
async function check(b: Uint8Array, depth: number, budget: Budget): Promise<Verdict> {
  const entries = readZip(b, budget);
  if (!entries) return BAD;
  const named = new Map(entries.map((e) => [e.name, e]));
  const types = named.get("[Content_Types].xml");
  const mimetype = named.get("mimetype");
  if (types && mimetype) return BAD;
  let mime: string | null = null;
  if (mimetype) {
    const bytes = await bytesOf(b, mimetype, 256, budget);
    const kind = bytes && xmlText(bytes)?.trim();
    mime = Object.keys(TYPES).find((m) => m.startsWith(ODF) && m === kind) ?? null;
    if (entries.some((e) => /(^|\/)(basic|scripts|dialogs)\//iu.test(e.name))) return MACROS;
  } else if (named.has("xl/workbook.xml")) mime = `${OFFICE}.spreadsheetml.sheet`;
  else if (named.has("word/document.xml")) mime = `${OFFICE}.wordprocessingml.document`;
  else if (named.has("ppt/presentation.xml")) mime = `${OFFICE}.presentationml.presentation`;
  if (depth === 0 && (!mime || (!types && !mimetype))) return BAD;
  if (entries.some((e) => MACRO_PART.test(e.name.normalize("NFKC")))) return MACROS;
  // a part can be renamed, so the content types and every relationship are read for what they say each part is
  const xml = entries.filter((e) => e === types || /\.rels$/iu.test(e.name) || /(^|\/)externalLinks\/[^/]*\.xml$/iu.test(e.name));
  for (const e of xml) {
    if ((budget.xml -= e.size) < 0) return BAD;
    const bytes = await bytesOf(b, e, XML_PART, budget);
    const text = bytes && xmlText(bytes);
    if (!text) return BAD;
    const refused = e === types ? MACRO_TYPE.test(text) : /\.rels$/iu.test(e.name) ? badRels(text) : /<(\w+:)?ddeLink\b/iu.test(text);
    if (refused) return MACROS;
  }
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    const start = await head(b, e);
    if (!start) return BAD;
    if (startsWith(start, OLE_MAGIC)) return MACROS;
    if (start[0] === 0x50 && start[1] === 0x4b && start[2] === 3 && start[3] === 4) {
      if (depth >= MAX_DEPTH || e.size > budget.alive) return BAD;
      budget.alive -= e.size;
      const inner = await bytesOf(b, e, e.size, budget);
      const found = inner ? await check(inner, depth + 1, budget) : BAD;
      budget.alive += e.size;
      if (found.v !== "ok") return found;
    }
  }
  return { v: "ok", mime };
}

async function inZip(b: Uint8Array): Promise<string | "macros" | null> {
  const found = await check(b, 0, newBudget());
  return found.v === "macros" ? "macros" : found.v === "ok" ? found.mime : null;
}

// Word, Excel and PowerPoint files kept under a password are compound files too; their directory names two streams. Only the
// directory's own sectors are read, and at most 64 of them, to give the person a better message than the one for old formats.
export function passwordProtected(b: Uint8Array): boolean {
  if (b.length < 512 || !startsWith(b, OLE_MAGIC)) return false;
  const shift = u16(b, 0x1e);
  if (shift !== 9 && shift !== 12) return false;
  const size = 1 << shift;
  const per = size / 4;
  let found = 0;
  let sector = u32(b, 0x30);
  for (let hops = 0; hops < 64 && sector < 0xfffffffa; hops++) {
    const at = (sector + 1) * size;
    if (at + size > b.length) return false;
    for (let e = at; e < at + size; e += 128) {
      const len = u16(b, e + 64);
      if (len < 2 || len > 64) continue;
      const name = new TextDecoder("utf-16le").decode(b.subarray(e, e + len - 2));
      if (name === "EncryptionInfo" || name === "EncryptedPackage") found++;
    }
    const slot = Math.floor(sector / per);
    if (slot >= 109) return found >= 2;
    const fat = u32(b, 0x4c + slot * 4);
    const next = (fat + 1) * size + (sector % per) * 4;
    if (fat >= 0xfffffffa || next + 4 > b.length) break;
    sector = u32(b, next);
  }
  return found >= 2;
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
