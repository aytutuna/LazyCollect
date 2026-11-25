import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { randomId } from "../src/util";
import { api, login, openRequest, pdf, randomBytes, sha, upload } from "./helpers";

const text = (s: string) => new TextEncoder().encode(s);
const u16 = (n: number) => [n & 255, n >> 8];
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

// a zip with every part stored, or deflated where a test asks for it
async function zip(parts: [string, string][], deflate: string[] = []): Promise<Uint8Array> {
  const out: number[] = [];
  const central: number[] = [];
  for (const [name, body] of parts) {
    let data = text(body);
    const method = deflate.includes(name) ? 8 : 0;
    if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    const n = [...text(name)];
    const at = out.length;
    out.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u32(0), ...u32(0), ...u32(data.length), ...u32(body.length), ...u16(n.length), ...u16(0), ...n, ...data);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u32(0), ...u32(0), ...u32(data.length), ...u32(body.length), ...u16(n.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(at), ...n);
  }
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(parts.length), ...u16(parts.length), ...u32(central.length), ...u32(out.length), ...u16(0)];
  return new Uint8Array([...out, ...central, ...end]);
}

const OFFICE = "application/vnd.openxmlformats-officedocument";
const types = (main: string) => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/x" ContentType="${main}"/></Types>`;
const xlsx = (extra: [string, string][] = [], main = `${OFFICE}.spreadsheetml.sheet.main+xml`) =>
  zip([["[Content_Types].xml", types(main)], ["xl/workbook.xml", "<workbook/>"], ...extra]);
const docx = () => zip([["[Content_Types].xml", types(`${OFFICE}.wordprocessingml.document.main+xml`)], ["word/document.xml", "<document/>"]]);
const pptx = () => zip([["[Content_Types].xml", types(`${OFFICE}.presentationml.presentation.main+xml`)], ["ppt/presentation.xml", "<p/>"]]);
const ods = (extra: [string, string][] = []) => zip([["mimetype", "application/vnd.oasis.opendocument.spreadsheet"], ["content.xml", "<c/>"], ...extra]);

// a compound file with a root and up to three named streams, in 512-byte sectors: the header, one FAT sector and one directory
// sector, then the workbook stream if one is given (padded to the 4,096 bytes a stream needs to sit outside the mini stream)
function ole(streams: string[], workbook?: Uint8Array): Uint8Array {
  const data = workbook && new Uint8Array(Math.max(4096, workbook.length));
  data?.set(workbook!);
  const used = data ? Math.ceil(data.length / 512) : 0;
  const b = new Uint8Array(512 * (3 + used));
  const set = (at: number, v: number[]) => b.set(v, at);
  set(0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  set(0x18, [...u16(0x3e), ...u16(3), ...u16(0xfffe), ...u16(9), ...u16(6)]);
  set(0x2c, u32(1));
  set(0x30, u32(1));
  set(0x38, u32(4096));
  set(0x3c, u32(0xfffffffe));
  set(0x44, u32(0xfffffffe));
  b.fill(0xff, 0x4c, 512);
  set(0x4c, u32(0));
  b.fill(0xff, 512, 1024);
  set(512, [...u32(0xfffffffd), ...u32(0xfffffffe)]);
  for (let i = 0; i < used; i++) set(512 + (2 + i) * 4, u32(i === used - 1 ? 0xfffffffe : 3 + i));
  if (data) b.set(data, 512 * 3);
  ["Root Entry", ...streams].slice(0, 4).forEach((name, i) => {
    const at = 1024 + i * 128;
    const units = [...name].flatMap((ch) => u16(ch.charCodeAt(0)));
    set(at, units);
    set(at + 64, u16(units.length + 2));
    b[at + 66] = i === 0 ? 5 : 2;
    if (name === "Workbook" && data) set(at + 116, [...u32(2), ...u32(data.length)]);
  });
  return b;
}

// the records an Excel file starts with: the start of the file, one sheet of the given kind, the end of that stretch
function biff(sheet: number): Uint8Array {
  const record = (type: number, body: number[]) => [...u16(type), ...u16(body.length), ...body];
  return new Uint8Array([...record(0x0809, [0, 6, 5, 0]), ...record(0x0085, [...u32(0), 0, sheet, 83, 104]), ...record(0x000a, [])]);
}

// a small compound file whose DIFAT chain loops on itself and claims thousands of sectors
function cyclic(): Uint8Array {
  const b = ole(["Workbook"]);
  b.set(u32(1), 0x44);
  b.set(u32(5000), 0x48);
  b.set(u32(1), 0x44);
  b.set(u32(5000), 0x2c);
  b.set(u32(1), 512 + 508);
  return b;
}

const put = (path: string, item: string, body: Uint8Array, name: string) => upload(path, item, body, { name });
const stored = () => env.DB_NA.prepare("SELECT mime, name FROM files").first<{ mime: string; name: string }>();
const setKinds = (cookie: string, kinds: unknown) => api("/api/file-kinds", { method: "PUT", cookie, body: { kinds } });
const fileCount = async () => (await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM files").first<{ n: number }>())!.n;

describe("file kinds", () => {
  it("takes the kinds that are on to begin with, each judged by its first bytes", async () => {
    const o = await openRequest();
    const item = o.req.items[0].id;
    const cases: [string, Uint8Array, string][] = [
      ["a.xlsx", await xlsx(), `${OFFICE}.spreadsheetml.sheet`],
      ["a.docx", await docx(), `${OFFICE}.wordprocessingml.document`],
      ["a.xls", ole(["Workbook"], biff(0)), "application/vnd.ms-excel"],
      ["a.doc", ole(["WordDocument"]), "application/msword"],
      ["a.csv", text("name,amount\nCôté,12\n"), "text/csv"],
    ];
    for (const [name, body, mime] of cases) {
      const res = await put(o.path, item, body, name);
      expect([name, res.status]).toEqual([name, 201]);
      const row = await env.DB_NA.prepare("SELECT mime, name FROM files WHERE id = ?").bind((await res.json<any>()).id).first();
      expect(row).toEqual({ mime, name });
    }
  });

  it("gives a file the extension of what it is, whatever it was called", async () => {
    const o = await openRequest();
    await put(o.path, o.req.items[0].id, await xlsx(), "report.pdf");
    expect((await stored())!.name).toBe("report.xlsx");
  });

  it("refuses files that can run macros, however they are packed", async () => {
    const o = await openRequest();
    const item = o.req.items[0].id;
    const refused: [string, Uint8Array][] = [
      ["a.xlsm", await xlsx([["xl/vbaProject.bin", "x"]], `${OFFICE}.spreadsheetml.sheet.main+xml`)],
      ["b.xlsx", await xlsx([["xl/vbaProject.bin", "x"]])],
      ["c.xlsx", await xlsx([["xl/macrosheets/sheet1.xml", "<m/>"]])],
      ["d.xlsx", await zip([["[Content_Types].xml", types("application/vnd.ms-excel.sheet.macroEnabled.main+xml")], ["xl/workbook.xml", "<w/>"]], ["[Content_Types].xml"])],
      ["e.docm", await zip([["[Content_Types].xml", types("application/vnd.ms-word.document.macroEnabled.main+xml")], ["word/document.xml", "<d/>"]])],
      ["f.xls", ole(["Workbook", "_VBA_PROJECT_CUR"], biff(0))],
      ["f2.xls", ole(["Workbook", "_vba_project_cur"], biff(0))],
      ["f3.xls", ole(["Workbook"], biff(1))],
      ["f4.xls", ole(["Workbook"], biff(6))],
      ["f5.xls", ole(["Workbook"])],
      ["f6.ppt", ole(["PowerPoint Document", "VBA"])],
      ["g.doc", ole(["WordDocument", "Macros"])],
      ["h.ods", await ods([["Basic/Standard/Module1.xml", "x"]])],
      ["j.xlsx", await xlsx([["xl/blob.bin", "x"]], "application/vnd.ms-office.vbaProject")],
      ["k.xlsx", await xlsx([["xl/_rels/workbook.xml.rels", '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="x"/>']])],
      ["l.xlsx", await xlsx([["xl/embeddings/a.xlsx", "x"]])],
      ["m.xlsx", await xlsx([["xl/activeX/activeX1.xml", "x"]])],
    ];
    for (const [name, body] of refused) {
      const res = await put(o.path, item, body, name);
      expect([name, res.status, (await res.json<any>()).error]).toEqual([name, 415, "macros"]);
    }
    expect(await fileCount()).toBe(0);
    expect((await env.FILES_NA.list()).objects).toHaveLength(0);
  });

  it("refuses what is not one of the kinds", async () => {
    const o = await openRequest();
    const item = o.req.items[0].id;
    const refused: [string, Uint8Array][] = [
      ["a.zip", await zip([["notes.txt", "hi"]])],
      ["b.xlsx", randomBytes(300)],
      ["c.xlsx", await zip([["[Content_Types].xml", types("x")], ["xl/workbook.bin", "x"]])],
      ["d.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])],
      ["e.csv", new Uint8Array([0x61, 0x2c, 0, 0x62, 0x0a])],
      ["f.exe", text("MZ plain")],
      ["g", text("name,amount\n")],
      ["h.xls", ole(["Contents"])],
      ["i.xls", cyclic()],
    ];
    for (const [name, body] of refused) {
      const res = await put(o.path, item, body, name);
      expect([name, res.status, (await res.json<any>()).error]).toEqual([name, 415, "unsupported_type"]);
    }
  });

  it("keeps the other kinds off until the owner turns them on", async () => {
    const o = await openRequest();
    const item = o.req.items[0].id;
    const deck = await pptx();
    const off = await put(o.path, item, deck, "deck.pptx");
    expect([off.status, (await off.json<any>()).error]).toEqual([415, "type_off"]);
    expect((await put(o.path, item, text("hello"), "a.txt")).status).toBe(415);
    expect((await put(o.path, item, await ods(), "a.ods")).status).toBe(415);

    expect((await setKinds(o.cookie, ["pdf", "pictures", "excel", "word", "csv", "powerpoint", "text", "opendocument"])).status).toBe(200);
    const again: [string, Uint8Array][] = [["deck.pptx", deck], ["a.txt", text("hello")], ["a.ods", await ods()]];
    for (const [name, body] of again) expect([name, (await put(o.path, item, body, name)).status]).toEqual([name, 201]);
  });

  it("refuses a kind that is switched off, even a pdf", async () => {
    const o = await openRequest();
    const item = o.req.items[0].id;
    await setKinds(o.cookie, ["excel"]);
    const res = await put(o.path, item, pdf(500), "a.pdf");
    expect([res.status, (await res.json<any>()).error]).toEqual([415, "type_off"]);
    expect((await put(o.path, item, await xlsx(), "a.xlsx")).status).toBe(201);
    expect(await fileCount()).toBe(1);
  });

  it("stores an office file as it was sent, encrypted, and the picker names what the account takes", async () => {
    const o = await openRequest();
    const body = await xlsx([["xl/sheets/s1.xml", "x".repeat(70_000)]]);
    const res = await put(o.path, o.req.items[0].id, body, "big.xlsx");
    expect(res.status).toBe(201);
    const file = await res.json<any>();
    const download = await api(`/api/files/${file.id}`, { cookie: o.cookie });
    expect(await sha(await download.arrayBuffer())).toBe(await sha(body));

    const view = await (await api(o.path)).json<any>();
    expect(view.accept).toEqual(expect.arrayContaining(["application/pdf", ".pdf", ".jpg", ".xlsx", ".docx", ".csv", "text/csv"]));
    expect(view.accept).not.toContain(".pptx");
    await setKinds(o.cookie, ["pdf"]);
    expect((await (await api(o.path)).json<any>()).accept).toEqual(["application/pdf", ".pdf"]);
  });

  it("is chosen by the owner only, from the known kinds, with at least one", async () => {
    const { cookie } = await openRequest();
    const defaults = await (await api("/api/file-kinds", { cookie })).json<any>();
    expect(defaults.kinds.filter((k: any) => k.on).map((k: any) => k.id)).toEqual(["pdf", "pictures", "excel", "word", "csv"]);
    expect(defaults.kinds.find((k: any) => k.id === "pictures")).toMatchObject({ suggested: true, extensions: ["jpg", "png", "webp", "heic", "heif"] });
    expect(defaults.kinds.find((k: any) => k.id === "text")).toMatchObject({ on: false, suggested: false });
    for (const kinds of [[], ["exe"], "pdf", [1], null]) {
      expect([kinds, (await setKinds(cookie, kinds)).status]).toEqual([kinds, 400]);
    }
    const firmId = (await env.CONTROL.prepare("SELECT id FROM firms").first<any>())!.id;
    await env.CONTROL.prepare("INSERT INTO users (id, firm_id, email, role, created_at) VALUES (?, ?, 'staff@firm.test', 'member', ?)").bind(randomId(), firmId, Date.now()).run();
    const staff = await login("staff@firm.test");
    expect((await setKinds(staff, ["pdf"])).status).toBe(403);
    expect((await api("/api/file-kinds", { cookie: staff })).status).toBe(200);
    expect(await (await setKinds(cookie, ["csv", "pdf"])).json()).toEqual({ kinds: ["pdf", "csv"] });
    expect((await env.DB_NA.prepare("SELECT action FROM audit WHERE action = 'filekinds.update'").all()).results).toHaveLength(1);
  });
});

describe("downloads of the new kinds", () => {
  it("are attachments only, never shown in the browser", async () => {
    const o = await openRequest();
    const item = o.req.items[0].id;
    const file = await (await put(o.path, item, text("a,b\n1,2\n"), "t.csv")).json<any>();
    const res = await api(`/api/files/${file.id}`, { cookie: o.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="t\.csv"/);
    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await api(`/api/files/${file.id}/view`, { cookie: o.cookie })).status).toBe(415);
    const sheet = await (await put(o.path, item, await xlsx(), "t.xlsx")).json<any>();
    expect((await api(`/api/files/${sheet.id}/view`, { cookie: o.cookie })).status).toBe(415);
    expect((await api(`/api/files/${sheet.id}`, { cookie: o.cookie })).headers.get("content-disposition")).toMatch(/^attachment/);
  });
});
