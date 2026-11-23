import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildItem, fitJpeg, irccName, limitBytes, prepareAll, type Decode, type Decoded, type Input } from "./ircc";
import { ZipWriter, crc32 } from "./zip";

// a 1x1 JPEG padded with comment segments up to the size a real photo would have
const TINY = Uint8Array.from(atob("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="), (c) => c.charCodeAt(0));
function jpeg(size: number): Uint8Array {
  const out = new Uint8Array(Math.max(size, TINY.length));
  out.set(TINY.subarray(0, 2));
  let at = 2;
  while (out.length - at - (TINY.length - 2) > 4) {
    const n = Math.min(out.length - at - (TINY.length - 2), 65_000);
    out.set([0xff, 0xfe, ((n - 2) >> 8) & 0xff, (n - 2) & 0xff], at);
    at += n;
  }
  out.set(TINY.subarray(2), at);
  return out;
}

// bytes grow with the pixel count and the quality, as they do for a real page
function synthetic(width: number, height: number, perPixel = 0.6): Decoded & { calls: [number, number][]; closed: boolean } {
  const calls: [number, number][] = [];
  const image = {
    width,
    height,
    calls,
    closed: false,
    async encode(edge: number, quality: number) {
      calls.push([edge, quality]);
      const k = Math.min(1, edge / Math.max(width, height));
      const w = Math.round(width * k);
      const h = Math.round(height * k);
      return { bytes: jpeg(Math.round(w * h * quality * perPixel)), width: w, height: h };
    },
    close() {
      image.closed = true;
    },
  };
  return image;
}

const fake = (...sizes: [number, number][]): Decode => {
  let at = 0;
  return async () => synthetic(...sizes[at++ % sizes.length]);
};
const image = (name: string): Input => ({ name, mime: "image/jpeg", blob: new Blob([jpeg(2_000) as BlobPart]) });
const pages = async (blob: Blob) => (await PDFDocument.load(await blob.arrayBuffer())).getPageCount();

describe("fitJpeg", () => {
  it("keeps the first try when it fits", async () => {
    const image = synthetic(3000, 4000);
    const fit = await fitJpeg(image, 5_000_000);
    expect(fit).toMatchObject({ fits: true, reduced: false, width: 1800, height: 2400 });
    expect(image.calls).toEqual([[2400, 0.85]]);
  });

  it("steps quality and size down until it fits, never below about 150 dpi at letter size", async () => {
    const image = synthetic(3000, 4000);
    const fit = await fitJpeg(image, 700_000);
    expect(fit.fits).toBe(true);
    expect(fit.reduced).toBe(true);
    expect(fit.bytes.length).toBeLessThanOrEqual(700_000);
    expect(Math.max(fit.width, fit.height)).toBeGreaterThanOrEqual(1650);
  });

  it("gives up at the floor and says it does not fit", async () => {
    const image = synthetic(3000, 4000);
    const fit = await fitJpeg(image, 10_000);
    expect(fit.fits).toBe(false);
    expect(image.calls.at(-1)).toEqual([1650, 0.45]);
    expect(Math.max(fit.width, fit.height)).toBe(1650);
  });

  it("does not enlarge a small image", async () => {
    const image = synthetic(1000, 800);
    await fitJpeg(image, 10);
    expect(new Set(image.calls.map(([edge]) => edge))).toEqual(new Set([1000]));
    expect(image.calls).toHaveLength(5);
  });
});

describe("irccName", () => {
  it("joins the document and the person with hyphens", () => {
    expect(irccName("Passport — Amira Haddad", "Client", new Set())).toBe("Passport-Amira-Haddad.pdf");
  });

  it("uses the person given when the label has none", () => {
    expect(irccName("Passport", "Amira Haddad", new Set())).toBe("Passport-Amira-Haddad.pdf");
  });

  it("drops accents, apostrophes, brackets and symbols", () => {
    expect(irccName("Résumé — José O'Neil", "", new Set())).toBe("Resume-Jose-ONeil.pdf");
    expect(irccName("Provincial attestation letter (PAL or TAL)", "", new Set())).toBe("Provincial-attestation-letter.pdf");
    expect(irccName("Host's status & address / copy", "", new Set())).toBe("Hosts-status-address-copy.pdf");
  });

  it("does not end the document part on a joining word", () => {
    expect(irccName("Previous diplomas and transcripts", "Amira Haddad", new Set())).toBe("Previous-diplomas-Amira-Haddad.pdf");
  });

  it("stays under 50 characters", () => {
    const name = irccName("Family members' passports and civil documents — Alexandria Konstantinopoulos-Papadopoulos", "", new Set());
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name).toMatch(/^[A-Za-z0-9-]+\.pdf$/);
  });

  it("falls back for a label with nothing usable and keeps names unique", () => {
    const taken = new Set<string>();
    expect(irccName("你好", "", taken)).toBe("Document.pdf");
    expect(irccName("你好", "", taken)).toBe("Document-2.pdf");
    expect(irccName("Passport", "", taken)).toBe("Passport.pdf");
    expect(irccName("passport", "", taken)).toBe("passport-2.pdf");
  });
});

describe("buildItem", () => {
  it("combines several photos into one PDF that fits", async () => {
    const files = [image("a.jpg"), image("b.jpg"), image("c.jpg")];
    const [out] = await buildItem("Passport.pdf", files, limitBytes(2), fake([3000, 4000], [4000, 3000], [3000, 4000]));
    expect(out).toMatchObject({ name: "Passport.pdf", ok: true });
    expect(out.size).toBeLessThanOrEqual(limitBytes(2));
    expect(out.notes).toEqual([{ code: "reduced" }]);
    expect(await pages(out.blob)).toBe(3);
  });

  it("closes each image once it is on its page", async () => {
    const seen: ReturnType<typeof synthetic>[] = [];
    const decode: Decode = async () => {
      const i = synthetic(2000, 3000);
      seen.push(i);
      return i;
    };
    await buildItem("x.pdf", [image("a.jpg"), image("b.jpg")], limitBytes(4), decode);
    expect(seen.map((i) => i.closed)).toEqual([true, true]);
  });

  it("flags photos that cannot reach the limit at a readable size", async () => {
    const [out] = await buildItem("x.pdf", [image("a.jpg"), image("b.jpg")], 100_000, fake([3000, 4000]));
    expect(out).toMatchObject({ ok: false, notes: [{ code: "images_over" }] });
    expect(await pages(out.blob)).toBe(2);
  });

  it("uses a single PDF under the limit as it is", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const blob = new Blob([(await doc.save()) as BlobPart]);
    const [out] = await buildItem("x.pdf", [{ name: "a.pdf", mime: "application/pdf", blob }], limitBytes(4), fake([10, 10]));
    expect(out).toMatchObject({ name: "x.pdf", ok: true, notes: [] });
    expect(out.blob).toBe(blob);
  });

  it("passes a single PDF over the limit on unchanged", async () => {
    const blob = new Blob([new Uint8Array(3_000_000)]);
    const [out] = await buildItem("x.pdf", [{ name: "scan.pdf", mime: "application/pdf", blob }], limitBytes(2), fake([10, 10]));
    expect(out).toMatchObject({ name: "x.pdf", ok: false, notes: [{ code: "pdf_over" }] });
    expect(out.blob).toBe(blob);
  });

  it("merges PDFs and photos in order", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    const pdf: Input = { name: "a.pdf", mime: "application/pdf", blob: new Blob([(await doc.save()) as BlobPart]) };
    const [out] = await buildItem("x.pdf", [image("a.jpg"), pdf, image("b.jpg")], limitBytes(4), fake([2000, 3000]));
    expect(out.ok).toBe(true);
    expect(await pages(out.blob)).toBe(4);
  });

  it("sends a file it cannot read on unchanged with its name", async () => {
    const heic: Input = { name: "IMG_1.HEIC", mime: "image/heic", blob: new Blob(["x"]) };
    const outs = await buildItem("Passport-Amira.pdf", [image("a.jpg"), heic], limitBytes(4), async (b) => {
      if (b === heic.blob) throw new Error("no decoder");
      return synthetic(2000, 3000);
    });
    expect(outs.map((o) => o.name)).toEqual(["Passport-Amira-1.jpg", "Passport-Amira-2.heic"]);
    expect(outs[0].notes).toEqual([{ code: "unreadable", name: "IMG_1.HEIC" }]);
    expect(outs.every((o) => !o.ok)).toBe(true);
  });

  it("sends a PDF it cannot open on unchanged", async () => {
    const bad: Input = { name: "bad.pdf", mime: "application/pdf", blob: new Blob(["not a pdf"]) };
    const outs = await buildItem("x.pdf", [bad, image("a.jpg")], limitBytes(4), fake([2000, 3000]));
    expect(outs).toHaveLength(2);
    expect(outs[0].notes).toEqual([{ code: "unreadable", name: "bad.pdf" }]);
  });
});

describe("zip", () => {
  it("checksums like the standard", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes a readable archive of stored files", async () => {
    const zip = new ZipWriter();
    await zip.add("a.txt", new Blob(["hello"]), Date.UTC(2026, 10, 1));
    await zip.add("subé.txt", new Blob(["world!"]));
    const bytes = new Uint8Array(await zip.finish().arrayBuffer());
    const v = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    let at = v.getUint32(end + 16, true);
    const found: [string, string][] = [];
    for (let i = 0; i < 2; i++) {
      expect(v.getUint32(at, true)).toBe(0x02014b50);
      const size = v.getUint32(at + 24, true);
      const n = v.getUint16(at + 28, true);
      const local = v.getUint32(at + 42, true);
      const name = new TextDecoder().decode(bytes.slice(at + 46, at + 46 + n));
      const data = local + 30 + v.getUint16(local + 26, true);
      const body = bytes.slice(data, data + size);
      expect(v.getUint32(at + 16, true)).toBe(crc32(body));
      found.push([name, new TextDecoder().decode(body)]);
      at += 46 + n;
    }
    expect(found).toEqual([["a.txt", "hello"], ["subé.txt", "world!"]]);
  });
});

describe("prepareAll", () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, name: `p${i}.jpg`, mime: "image/jpeg" }));
  const run = (extra = {}) => ({ signal: new AbortController().signal, progress: () => {}, fetch: async () => new Blob([jpeg(2_000) as BlobPart]), decode: fake([2000, 3000]), ...extra });

  it("builds one named PDF per item and lists each one", async () => {
    const seen: [number, string][] = [];
    const { zip, rows } = await prepareAll(
      [{ label: "Passport — Amira Haddad", files: files(2) }, { label: "Police certificates", files: files(1) }],
      "Amira Haddad",
      4,
      run({ progress: (n: number, label: string) => seen.push([n, label]) }),
    );
    expect(rows.map((r) => [r.name, r.ok])).toEqual([["Passport-Amira-Haddad.pdf", true], ["Police-certificates-Amira-Haddad.pdf", true]]);
    expect(seen).toEqual([[0, "Passport — Amira Haddad"], [1, "Police certificates"], [2, ""]]);
    expect(zip.size).toBeGreaterThan(rows[0].size + rows[1].size);
  });

  it("stops when cancelled", async () => {
    const stop = new AbortController();
    const go = prepareAll([{ label: "A", files: files(1) }, { label: "B", files: files(1) }], "", 4, run({ signal: stop.signal, progress: (n: number) => n === 1 && stop.abort() }));
    await expect(go).rejects.toThrow();
  });
});
