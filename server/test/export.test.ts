import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { cleanName, crc32, uniqueName } from "../src/zip";
import { api, inDays, jpeg, login, openRequest, pdf, setup, sha, upload } from "./helpers";

type Entry = { name: string; crc: number; data: Uint8Array };

// reads the central directory, then checks each local header and descriptor against it
function unzip(buf: Uint8Array): Entry[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 24, true);
    expect(v.getUint32(at + 20, true)).toBe(size);
    expect(v.getUint16(at + 10, true)).toBe(0);
    const nameLen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLen));
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    expect(v.getUint16(local + 6, true) & 0x0808).toBe(0x0808);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    expect(v.getUint32(start + size, true)).toBe(0x08074b50);
    expect(v.getUint32(start + size + 4, true)).toBe(crc);
    expect(v.getUint32(start + size + 8, true)).toBe(size);
    out.push({ name, crc, data: buf.slice(start, start + size) });
    at += 46 + nameLen;
  }
  return out;
}

describe("zip helpers", () => {
  it("computes the standard CRC32, also piece by piece", () => {
    const text = new TextEncoder().encode("123456789");
    expect(crc32(text)).toBe(0xcbf43926);
    expect(crc32(text.subarray(4), crc32(text.subarray(0, 4)))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("cleans names and keeps them apart", () => {
    expect(cleanName("../../etc/passwd", 80, "x")).toBe("_.._etc_passwd");
    expect(cleanName("  ..hidden\u0007\u0000name  ", 80, "x")).toBe("hidden__name");
    expect(cleanName("a\b:c?", 80, "x")).toBe("a_b_c_");
    expect(cleanName("...", 80, "item")).toBe("item");
    expect(cleanName("é".repeat(100), 10, "x")).toBe("é".repeat(10));
    expect(cleanName("name. ", 80, "x")).toBe("name");
    const seen = new Set<string>();
    expect([uniqueName("Passport", seen), uniqueName("passport", seen), uniqueName("Passport", seen)]).toEqual(["Passport", "passport (2)", "Passport (3)"]);
  });
});

async function withFiles() {
  const o = await openRequest();
  const [a, b] = o.req.items;
  const files = [
    { item: a.id, bytes: pdf(70_000), name: "front.pdf" },
    { item: a.id, bytes: jpeg(3000), name: "back.jpg" },
    { item: b.id, bytes: pdf(10), name: "visa.pdf" },
  ];
  for (const f of files) expect((await upload(o.path, f.item, f.bytes, { name: f.name })).status).toBe(201);
  return { ...o, files };
}

describe("request export", () => {
  it("streams every file back as it was uploaded", async () => {
    const { cookie, req, files } = await withFiles();
    const res = await api(`/api/requests/${req.id}/export`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('attachment; filename="2025 taxes.zip"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const entries = unzip(new Uint8Array(await res.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual(["Passport/1.pdf", "Passport/2.jpg", "Visa/1.pdf"]);
    for (const [i, e] of entries.entries()) {
      expect(await sha(e.data)).toBe(await sha(files[i].bytes));
      expect(e.crc).toBe(crc32(files[i].bytes));
    }
    const logged = (await env.DB_NA.prepare("SELECT action, object_type, object_id, meta FROM audit WHERE action = 'export'").all<any>()).results;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ object_type: "request", object_id: req.id });
    expect(JSON.parse(logged[0].meta)).toEqual({ files: 3 });
  });

  it("leaves out removed and unfinished files and gives items with equal labels their own folders", async () => {
    const { cookie, req, files } = await withFiles();
    const added = await (await api(`/api/requests/${req.id}/items`, { method: "POST", cookie, body: { label: "Passport" } })).json<any>();
    await env.DB_NA.prepare("UPDATE files SET deleted_at = 1 WHERE name = 'back.jpg'").run();
    await env.DB_NA.prepare("UPDATE files SET state = 'pending' WHERE name = 'visa.pdf'").run();
    expect(added.label).toBe("Passport");
    const res = await api(`/api/requests/${req.id}/export`, { cookie });
    const entries = unzip(new Uint8Array(await res.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual(["Passport/1.pdf"]);
    expect(await sha(entries[0].data)).toBe(await sha(files[0].bytes));
  });

  it("answers 409 for a request without files and 404 for a deleted one", async () => {
    const { cookie, client } = await setup();
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "Empty", deadline: inDays(3), items: [{ label: "x" }] } })).json<any>();
    const res = await api(`/api/requests/${req.id}/export`, { cookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_files" });
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    expect((await api(`/api/requests/${req.id}/export`, { cookie })).status).toBe(404);
    expect(await env.DB_NA.prepare("SELECT 1 FROM audit WHERE action = 'export'").first()).toBeNull();
  });

  it("is 404 for another firm, 401 without a session and 405 for HEAD", async () => {
    const { cookie, req } = await withFiles();
    const other = await login("other@firm.test");
    expect((await api(`/api/requests/${req.id}/export`, { cookie: other })).status).toBe(404);
    expect((await api(`/api/requests/${req.id}/export`)).status).toBe(401);
    expect((await api(`/api/requests/${req.id}/export`, { method: "HEAD", cookie })).status).toBe(405);
    expect(await env.DB_NA.prepare("SELECT 1 FROM audit WHERE action = 'export'").first()).toBeNull();
  });

  it("names the download after a hostile title safely", async () => {
    const { cookie, req } = await withFiles();
    await api(`/api/requests/${req.id}`, { method: "PATCH", cookie, body: { title: '../"a"\r\nb' } });
    const res = await api(`/api/requests/${req.id}/export`, { cookie });
    const header = res.headers.get("content-disposition")!;
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('filename="__a___b.zip"');
  });
});
