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

type Entry = { name: string; flags: number; method: number; crc: number; packed: number; size: number; at: number; data: number };

// Limits for looking at one upload: parts in all (every level counted), the xml read, the bytes of nested packages held at once,
// and everything inflated.
type Budget = { parts: number; xml: number; alive: number; out: number };
const newBudget = (): Budget => ({ parts: 3000, xml: 4 << 20, alive: 25 << 20, out: 64 << 20 });
const XML_PART = 2 << 20;
const PEEK = 8192;
const MAX_DEPTH = 2;

const EOCD = 0x06054b50;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const goodName = (name: string) => {
  if (!name || name.startsWith("/") || /[\\\0%]/.test(name)) return false;
  return name.replace(/\/$/, "").split("/").every((s) => s !== "" && s !== "." && s !== "..");
};

// A zip read strictly: the end record is the last 22 bytes, the central directory fills exactly the space before it, every entry
// has the same name, method and sizes in its local header, the entries tile the file with nothing between them, and no name is
// ambiguous. null for anything else, since two readers that disagree about a file are how a macro gets past a check.
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
    const crc = u32(b, at + 16);
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
    if (!goodName(name) || seen.has(key) || (name.endsWith("/") && (size !== 0 || packed > 2))) return null;
    seen.add(key);
    // the local header says the same thing as the central one
    if (local + 30 > cdAt || u32(b, local) !== 0x04034b50 || u16(b, local + 6) !== flags || u16(b, local + 8) !== method) return null;
    const ln = u16(b, local + 26);
    const data = local + 30 + ln + u16(b, local + 28);
    if (ln !== n || data + packed > cdAt) return null;
    for (let j = 0; j < n; j++) if (b[local + 30 + j] !== b[at + 46 + j]) return null;
    if (!(flags & 8) && (u32(b, local + 18) !== packed || u32(b, local + 22) !== size)) return null;
    out.push({ name, flags, method, crc, packed, size, at: local, data });
    at = next;
  }
  if (at !== end) return null;
  // no bytes between entries, before the first or after the last: what is not in the directory is not in the file
  const sorted = [...out].sort((x, y) => x.at - y.at);
  let pos = 0;
  for (const e of sorted) {
    if (e.at !== pos) return null;
    pos = e.data + e.packed;
    if (e.flags & 8) {
      // the data descriptor that follows: the signature is optional, the crc and the two sizes are not
      const sig = u32(b, pos) === 0x08074b50 ? 4 : 0;
      if (u32(b, pos + sig) !== e.crc || u32(b, pos + sig + 4) !== e.packed || u32(b, pos + sig + 8) !== e.size) return null;
      pos += sig + 12;
    }
  }
  return pos === cdAt ? out : null;
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

// a part's whole content, charged to the inflate budget, held to `max`, and checked against the crc the directory gave it
async function bytesOf(b: Uint8Array, e: Entry, max: number, budget: Budget): Promise<Uint8Array | null> {
  if (e.size > max || (budget.out -= e.size) < 0) return null;
  const data = b.subarray(e.data, e.data + e.packed);
  const bytes = e.method === 0 ? data : await inflate(data, e.size, true);
  return bytes && crc32(bytes) === e.crc ? bytes : null;
}

// the first few bytes of a part, without unpacking the rest; a part that says it is shorter than that is read whole, so a
// declared size can't cut it short
async function head(b: Uint8Array, e: Entry): Promise<Uint8Array | null> {
  return peek(b, e, 8);
}

async function peek(b: Uint8Array, e: Entry, n: number): Promise<Uint8Array | null> {
  const data = b.subarray(e.data, e.data + e.packed);
  if (e.method === 0) return data.subarray(0, n);
  return e.size < n ? inflate(data, e.size, true, 256) : inflate(data, n, false, 256);
}

// xml as saved, in UTF-8 or in UTF-16 of either order; null for what a reader could take more than one way. Character references
// are left alone here: they are decoded value by value after the markup has been read.
function xmlText(bytes: Uint8Array, partial = false): string | null {
  let label = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
  else if (bytes[0] === 0 && bytes[1] !== 0) label = "utf-16be";
  else if (bytes[1] === 0 && bytes[0] !== 0) label = "utf-16le";
  let text: string;
  try {
    text = new TextDecoder(label, { fatal: !partial, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  const declared = /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(text)?.[1];
  if (text.includes("\0") || (declared && !/^utf-?(8|16)(le|be)?$/i.test(declared))) return null;
  // comments, CDATA, entity and type declarations and processing instructions other than the xml declaration are how a start tag
  // gets hidden or faked; Office never writes them in these parts
  if (/<!--|<!\[CDATA\[|<!DOCTYPE|<!ENTITY/i.test(text) || text.replace(/^\s*<\?xml[^>]*\?>/i, "").includes("<?")) return null;
  return text;
}

// an attribute value with its references decoded and look-alike letters folded
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const value = (raw: string) =>
  raw
    .replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (whole, hex, dec, name) => {
      if (name) return NAMED[name.toLowerCase()] ?? whole;
      const n = hex ? parseInt(hex, 16) : Number(dec);
      return n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .normalize("NFKC");

// The elements of this name, each with its attributes read one by one with the quotes respected, so a ">" or a look-alike
// attribute inside a value can't hide or pass for another. null when the markup can't be followed.
function elements(text: string, name: string): Map<string, string>[] | null {
  const out: Map<string, string>[] = [];
  const start = new RegExp(`<(?:[^\\s<>/:=!?]+:)?${name}(?=[\\s/>])`, "giu");
  for (let m = start.exec(text); m; m = start.exec(text)) {
    const attrs = new Map<string, string>();
    let at = start.lastIndex;
    for (;;) {
      while (/\s/.test(text[at] ?? "")) at++;
      if (at >= text.length) return null;
      if (text[at] === ">" || (text[at] === "/" && text[at + 1] === ">")) break;
      const n = /^[^\s=/>"']+/.exec(text.slice(at, at + 200))?.[0];
      if (!n) return null;
      at += n.length;
      while (/\s/.test(text[at] ?? "")) at++;
      if (text[at++] !== "=") return null;
      while (/\s/.test(text[at] ?? "")) at++;
      const quote = text[at++];
      if (quote !== '"' && quote !== "'") return null;
      const close = text.indexOf(quote, at);
      if (close < 0) return null;
      if (!attrs.has(n.toLowerCase())) attrs.set(n.toLowerCase(), value(text.slice(at, close)));
      at = close + 1;
    }
    out.push(attrs);
    start.lastIndex = at;
  }
  return out;
}

// the local name of the first element inside the root, from the start of a part; null when the tags can't be followed in it
function firstChild(text: string): string | null {
  const body = text.replace(/^\s*<\?xml[^>]*\?>/i, "");
  const tag = (from: number) => {
    if (from < 0) return null;
    const open = /<(?:[^\s<>/:=!?]+:)?([^\s<>/:=!?]+)/y;
    open.lastIndex = from;
    const m = open.exec(body);
    if (!m) return null;
    let quote = "";
    for (let at = open.lastIndex; at < body.length; at++) {
      const c = body[at];
      if (quote) quote = c === quote ? "" : quote;
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") return { name: m[1].toLowerCase(), end: at + 1, empty: body[at - 1] === "/" };
    }
    return null;
  };
  const root = tag(body.indexOf("<"));
  if (!root || root.empty) return null;
  const next = body.indexOf("<", root.end);
  return next >= 0 && body.slice(root.end, next).trim() === "" ? (tag(next)?.name ?? null) : null;
}

// parts that carry or can start code
const MACRO_PART = /(^|\/)vbaProject\.bin$|(^|\/)vbaData\.xml$|^xl\/macrosheets\/|^xl\/dialogsheets\/|(^|\/)activeX\//iu;
// the type of a part or a relationship that names a macro-enabled document, a VBA project, an ActiveX control or an embedded object
const MACRO_TYPE = /macroEnabled|vbaProject|vbaData|activeX|oleObject|macrosheet|xlMacro/iu;
const CHUNK = /aFChunk/iu;
// relationships that fetch a template, a sub-document or a frame from where the target points
const FETCHING = /\/(attachedTemplate|subDocument|frame)$/iu;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (b: Uint8Array, magic: number[]) => magic.every((x, i) => b[i] === x);

// only a path inside the package or on this computer is local; every other spelling, scheme or share is taken as remote
const localForm = (t: string) => {
  if (/^(file:\/\/\/)?[a-z]:[\\/]/iu.test(t)) {
    const path = t.replace(/^file:\/\/\//i, "");
    return !/(^|[\\/])\.\.([\\/]|$)/.test(path) && !/[\\/]{2}/.test(path);
  }
  return /^[^/\\:\s][^:]*$/u.test(t);
};
const isLocal = (target: string) => {
  // every form it takes when percent-decoded is looked at, and invisible or control characters are never local
  const forms = [target.trim()];
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(forms[forms.length - 1]);
    } catch {
      return false;
    }
    if (next === forms[forms.length - 1]) break;
    forms.push(next);
  }
  return forms.every((f) => !/[\p{Cf}\p{Cc}]/u.test(f) && localForm(f.trim()));
};

type Verdict = { v: "ok"; mime: string | null } | { v: "macros" } | { v: "chunk" } | { v: "bad" };
const BAD: Verdict = { v: "bad" };
const MACROS: Verdict = { v: "macros" };
const CHUNKS: Verdict = { v: "chunk" };

// the path a relationship's target names, from the part the relationships belong to
function resolve(relsName: string, raw: string): string {
  let target = raw.replace(/\\/g, "/");
  try {
    target = decodeURIComponent(target);
  } catch {
    // left as it is; it will not match a part
  }
  if (target.startsWith("/")) return target.slice(1);
  const owner = relsName.replace(/(^|\/)_rels\/([^/]*)\.rels$/i, "$1");
  const parts = owner.split("/").slice(0, -1).concat(target.split("/"));
  const out: string[] = [];
  for (const p of parts) p === ".." ? out.pop() : p !== "." && p !== "" && out.push(p);
  return out.join("/");
}

// A zip package, and everything inside it. Macro, ActiveX and DDE parts and types are refused, so are relationships that fetch from
// elsewhere, a part that is an old compound file, and a package that claims to be two formats. A part that is itself a package (a
// chart's workbook) is checked the same way, down to two levels; one that is not a Word, Excel, PowerPoint or OpenDocument file is
// only held to the macro checks. At the top level the package has to be one of those four.
async function check(b: Uint8Array, depth: number, budget: Budget): Promise<Verdict> {
  const entries = readZip(b, budget);
  if (!entries) return BAD;
  const named = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  const types = named.get("[content_types].xml");
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
  if (entries.some((e) => /(^|\/)afchunk/iu.test(e.name))) return CHUNKS;
  if (entries.some((e) => MACRO_PART.test(e.name.normalize("NFKC")))) return MACROS;

  // a part can be renamed, so the types and every relationship are read for what they say each part is
  const linked = new Set<string>();
  const mustExist = new Set<string>();
  let chunk = false;
  const xml = entries.filter((e) => e === types || /\.rels$/iu.test(e.name));
  for (const e of xml) {
    if ((budget.xml -= e.size) < 0) return BAD;
    const bytes = await bytesOf(b, e, XML_PART, budget);
    const text = bytes && xmlText(bytes);
    if (!text) return BAD;
    const isTypes = e === types;
    const list = elements(text, isTypes ? "(?:Default|Override)" : "Relationship");
    if (!list) return BAD;
    for (const attrs of list) {
      const kind = (isTypes ? attrs.get("contenttype") : attrs.get("type")) ?? "";
      if (CHUNK.test(kind)) chunk = true;
      if (MACRO_TYPE.test(kind)) return MACROS;
      if (!isTypes && FETCHING.test(kind) && !isLocal(attrs.get("target") ?? "")) return MACROS;
      if (/externalLink|oleLink/iu.test(kind)) {
        const part = isTypes ? attrs.get("partname")?.replace(/^\//, "") : attrs.get("target") && resolve(e.name, attrs.get("target")!);
        if (part) linked.add(part.toLowerCase());
        if (part && !isTypes && /externalLink$/iu.test(kind) && !/^external$/iu.test(attrs.get("targetmode") ?? "")) mustExist.add(part.toLowerCase());
      }
    }
  }
  if (chunk) return CHUNKS;
  // an external link that names no part in the package could be a part under a name the check did not resolve
  for (const part of mustExist) if (!named.has(part)) return BAD;
  // an external link part may hold a DDE or OLE link, wherever it sits; the link is the first thing in it
  for (const e of entries) {
    if (!linked.has(e.name.toLowerCase()) && !/(^|\/)externalLinks\//iu.test(e.name)) continue;
    const bytes = await peek(b, e, Math.min(e.size, PEEK));
    const text = bytes && xmlText(bytes, true);
    if (text === null || !bytes) return BAD;
    if (/<(?:[^\s<>/:=!?]+:)?(ddeLink|oleLink)\b/iu.test(text)) return MACROS;
    // the root's first child tells what kind of link this is, and only an external workbook is taken
    if (firstChild(text) !== "externalbook") return BAD;
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

async function inZip(b: Uint8Array): Promise<string | "macros" | "chunk" | null> {
  const found = await check(b, 0, newBudget());
  return found.v === "ok" ? found.mime : found.v === "bad" ? null : found.v;
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
export async function inspect(family: "zip" | "text", whole: Uint8Array, name: string): Promise<string | "macros" | "chunk" | null> {
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
