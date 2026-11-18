import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ByteSource, CHUNK, cipherLength, decryptStream, encryptStream, fileKey } from "../src/crypt";
import { firmDek } from "../src/keys";
import { api, jpeg, openRequest, pdf, randomBytes, sha, upload } from "./helpers";

const TAG = 16;
const HEADER = 4;

const contains = (hay: Uint8Array, needle: Uint8Array) => new TextDecoder("latin1").decode(hay).includes(new TextDecoder("latin1").decode(needle));

const stream = (b: Uint8Array) => new Blob([b]).stream();

async function seal(plain: Uint8Array, key: CryptoKey, objectKey: string) {
  const source = new ByteSource(stream(plain));
  const first = await source.read(CHUNK);
  await env.FILES_NA.put(objectKey, encryptStream(key, source, first, plain.length).pipeThrough(new FixedLengthStream(cipherLength(plain.length))));
}

async function open(key: CryptoKey, objectKey: string): Promise<Uint8Array> {
  const object = await env.FILES_NA.get(objectKey);
  return new Uint8Array(await new Response(await decryptStream(key, object!.body)).arrayBuffer());
}

describe("chunk format", () => {
  it("round trips every boundary size", async () => {
    const key = await fileKey(randomBytes(32), "f".repeat(32));
    for (const size of [1, 65535, 65536, 65537, 200 * 1024, 3_000_000]) {
      const plain = randomBytes(size);
      await seal(plain, key, `t/${size}`);
      const object = await env.FILES_NA.get(`t/${size}`);
      expect(object!.size).toBe(cipherLength(size));
      expect(await sha(await open(key, `t/${size}`))).toBe(await sha(plain));
    }
  });

  it("fails with another file's key", async () => {
    const dek = randomBytes(32);
    await seal(randomBytes(1000), await fileKey(dek, "a".repeat(32)), "t/key");
    await expect(open(await fileKey(dek, "b".repeat(32)), "t/key")).rejects.toThrow();
    await expect(open(await fileKey(randomBytes(32), "a".repeat(32)), "t/key")).rejects.toThrow();
  });

  it("rejects a body shorter than its declared length", async () => {
    const key = await fileKey(randomBytes(32), "f".repeat(32));
    const plain = randomBytes(100_000);
    const source = new ByteSource(stream(plain));
    const first = await source.read(CHUNK);
    await expect(
      env.FILES_NA.put("t/short", encryptStream(key, source, first, 100_001).pipeThrough(new FixedLengthStream(cipherLength(100_001)))),
    ).rejects.toThrow();
    expect(await env.FILES_NA.head("t/short")).toBeNull();
  });
});

describe("firm key", () => {
  it("is created once even when first uploads race", async () => {
    const { req, path } = await openRequest();
    const item = req.items[0].id;
    const firm = (await env.CONTROL.prepare("SELECT id, dek_wrapped FROM firms").first<any>())!;
    expect(firm.dek_wrapped).toBeNull();
    const results = await Promise.all([upload(path, item, pdf(2000)), upload(path, item, pdf(3000)), upload(path, item, pdf(4000))]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const wrapped = (await env.CONTROL.prepare("SELECT dek_wrapped FROM firms").first<any>())!.dek_wrapped as string;
    expect(wrapped).toMatch(/^gcm1:/);
    const keys = await Promise.all(Array.from({ length: 4 }, () => firmDek(env, "na", firm.id, true)));
    expect(new Set(keys.map((k) => k.join(","))).size).toBe(1);
    expect((await env.CONTROL.prepare("SELECT dek_wrapped FROM firms").first<any>())!.dek_wrapped).toBe(wrapped);
  });

  it("does not open when its wrapped form is copied to another firm", async () => {
    const { req, path } = await openRequest();
    await upload(path, req.items[0].id, pdf(500));
    const a = (await env.CONTROL.prepare("SELECT id, dek_wrapped FROM firms").first<any>())!;
    await env.CONTROL.prepare("INSERT INTO firms (id, plan_status, created_at, dek_wrapped) VALUES (?, 'trialing', 1, ?)").bind("b".repeat(32), a.dek_wrapped).run();
    await expect(firmDek(env, "na", "b".repeat(32), false)).rejects.toThrow();
  });
});

describe("stored objects", () => {
  async function stored(size: number) {
    const { cookie, req, path } = await openRequest();
    const plain = pdf(size);
    const res = await upload(path, req.items[0].id, plain);
    expect(res.status).toBe(201);
    const file = await res.json<any>();
    const { objects } = await env.FILES_NA.list();
    expect(objects).toHaveLength(1);
    return { cookie, plain, file, key: objects[0].key };
  }

  it.each([8, 65535, 65536, 65537, 200 * 1024, 3_000_000])("round trips %i bytes through the API and never holds the plaintext", async (size) => {
    {
      const { cookie, plain, file, key } = await stored(size);
      const object = new Uint8Array(await (await env.FILES_NA.get(key))!.arrayBuffer());
      expect(object.length).toBe(cipherLength(size));
      expect(String.fromCharCode(...object.subarray(0, 3))).toBe("LC1");
      const probe = plain.subarray(Math.max(9, Math.floor(size / 2)), Math.floor(size / 2) + 8);
      if (size > 17) expect(contains(object, probe)).toBe(false);
      expect(contains(object, new TextEncoder().encode("%PDF-1.7"))).toBe(false);

      const res = await api(`/api/files/${file.id}`, { cookie });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String(size));
      expect(await sha(await res.arrayBuffer())).toBe(await sha(plain));
    }
  });

  const download = async (size: number, damage: (o: Uint8Array) => Uint8Array) => {
    const { cookie, file, key } = await stored(size);
    const object = new Uint8Array(await (await env.FILES_NA.get(key))!.arrayBuffer());
    await env.FILES_NA.put(key, damage(object));
    return api(`/api/files/${file.id}`, { cookie });
  };
  const chunkAt = (i: number) => HEADER + i * (CHUNK + TAG);

  it("refuses a flipped byte in the first chunk before sending anything", async () => {
    const res = await download(200 * 1024, (o) => (o[HEADER + 5] ^= 1, o));
    expect(res.status).toBe(500);
  });

  it("aborts the stream at a flipped byte in a later chunk", async () => {
    const res = await download(3_000_000, (o) => (o[chunkAt(20) + 7] ^= 1, o));
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("fails on a flipped tag byte", async () => {
    const res = await download(200 * 1024, (o) => (o[chunkAt(2) - 1] ^= 1, o));
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("fails when the last chunk is dropped", async () => {
    const res = await download(200 * 1024, (o) => o.slice(0, chunkAt(3)));
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("fails when the last chunk is dropped from an exact multiple of the chunk size", async () => {
    const res = await download(CHUNK * 3, (o) => o.slice(0, chunkAt(2)));
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("fails when a trailing chunk is cut mid-way", async () => {
    const res = await download(200 * 1024, (o) => o.slice(0, o.length - 5));
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("fails when extra bytes follow the last chunk", async () => {
    const res = await download(200 * 1024, (o) => new Uint8Array([...o, 1, 2, 3]));
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("fails when two chunks are swapped", async () => {
    const res = await download(200 * 1024, (o) => {
      const out = o.slice();
      out.set(o.subarray(chunkAt(2), chunkAt(3)), chunkAt(1));
      out.set(o.subarray(chunkAt(1), chunkAt(2)), chunkAt(2));
      return out;
    });
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("fails on a bad header", async () => {
    const res = await download(5000, (o) => (o[0] = 0x58, o));
    expect(res.status).toBe(500);
  });

  it("keeps jpeg uploads working end to end", async () => {
    const { cookie, req, path } = await openRequest();
    const plain = jpeg(150_000);
    const file = await (await upload(path, req.items[0].id, plain, { name: "photo.jpg" })).json<any>();
    const res = await api(`/api/files/${file.id}`, { cookie });
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(await sha(await res.arrayBuffer())).toBe(await sha(plain));
  });
});
