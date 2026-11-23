import { Hono } from "hono";
import { audit } from "./audit";
import { rateLimited } from "./auth";
import { findLink } from "./client";
import { ByteSource, CHUNK, cipherLength, decryptStream, encryptStream, fileKey } from "./crypt";
import { firmDek } from "./keys";
import { visible } from "./questions";
import { regionOf, type Region } from "./regions";
import type { AppEnv } from "./session";
import { HOUR, randomId } from "./util";
import { invalid, notFound } from "./validate";
import { sniff } from "./upload";

// Examples show a client what a good document looks like. They are the account's own content, kept apart from the files clients
// send. An item or template points at one by id; copying a template or repeating a request copies the id, so the object is
// shared. An example stays until no item and no template names it, which sweepFiles checks.
const MAX_SIZE = 2 * 1024 * 1024;
const MAX_EXAMPLES = 200;
const TYPES = ["image/jpeg", "image/png", "image/webp"];
const ID_RE = /^[0-9a-f]{32}$/;

// plain illustrations served as static assets from /examples/<name>.svg
export const BUILTIN_EXAMPLES = ["passport", "t4", "bank-statement", "void-cheque", "noa"];

// null clears it; undefined is not a built-in name or an id
export function parseExample(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && (BUILTIN_EXAMPLES.includes(v) || ID_RE.test(v)) ? v : undefined;
}

// every id among the references is one of this account's examples
export async function ownsExamples(db: D1Database, firmId: string, refs: (string | null | undefined)[]): Promise<boolean> {
  const ids = [...new Set(refs.filter((r): r is string => !!r && ID_RE.test(r)))];
  if (!ids.length) return true;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM examples WHERE firm_id = ? AND id IN (SELECT value FROM json_each(?))")
    .bind(firmId, JSON.stringify(ids))
    .first<{ n: number }>();
  return row!.n === ids.length;
}

export type ExampleRow = { id: string; r2_key: string; mime: string; size: number };

export async function sendExample(env: Env, region: Region, firmId: string, row: ExampleRow): Promise<Response | null> {
  const object = await regionOf(env, region).bucket.get(row.r2_key);
  if (!object) return null;
  const key = await fileKey(await firmDek(env, region, firmId, false), row.id);
  const plain = await decryptStream(key, object.body);
  return new Response(plain.pipeThrough(new FixedLengthStream(row.size)), {
    headers: {
      "Content-Type": row.mime,
      "Content-Length": String(row.size),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

// Rows go first and only the objects of rows that went are deleted. `before` spares an example that was uploaded but not yet saved onto an item.
export async function dropUnused(db: D1Database, bucket: R2Bucket, before: number, firmId?: string) {
  const { results } = await db
    .prepare(
      `DELETE FROM examples WHERE rowid IN (
         SELECT e.rowid FROM examples e WHERE e.created_at < ? AND (? IS NULL OR e.firm_id = ?)
         AND NOT EXISTS (SELECT 1 FROM items WHERE firm_id = e.firm_id AND example = e.id)
         AND NOT EXISTS (SELECT 1 FROM templates t, json_each(t.items_json) j WHERE t.firm_id = e.firm_id AND json_extract(j.value, '$.example') = e.id)
         LIMIT 200) RETURNING r2_key`,
    )
    .bind(before, firmId ?? null, firmId ?? null)
    .all<{ r2_key: string }>();
  if (results.length) await bucket.delete(results.map((r) => r.r2_key));
}

export const examples = new Hono<AppEnv>();

examples.post("/examples", async (c) => {
  const length = c.req.header("Content-Length");
  if (length !== undefined && Number(length) > MAX_SIZE) return c.json({ error: "too_big" }, 413);
  const body = c.req.raw.body;
  if (!body) return invalid(c);
  const bytes = await new ByteSource(body).read(MAX_SIZE + 1);
  if (bytes.length > MAX_SIZE) return c.json({ error: "too_big" }, 413);
  const mime = sniff(bytes);
  if (!mime || !TYPES.includes(mime)) return c.json({ error: "unsupported_type" }, 415);

  const firm = c.get("firm");
  const db = c.get("db");
  const region = firm.region as Region;
  const { bucket } = regionOf(c.env, region);
  const id = randomId();
  const r2Key = `f/${firm.id}/x/${id}`;
  const now = Date.now();
  const reserve = () =>
    db.batch([
      db
        .prepare(
          `INSERT INTO examples (id, firm_id, r2_key, mime, size, created_at) SELECT ?, ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM examples WHERE firm_id = ?) < ${MAX_EXAMPLES}`,
        )
        .bind(id, firm.id, r2Key, mime, bytes.length, now, firm.id),
      audit(c, "example.upload", "example", id, undefined, { sql: "EXISTS (SELECT 1 FROM examples WHERE firm_id = ? AND id = ?)", binds: [firm.id, id] }),
    ]);
  let [res] = await reserve();
  if (!res.meta.changes) {
    // examples nothing uses any more do not count against the cap
    await dropUnused(db, bucket, now - HOUR, firm.id);
    [res] = await reserve();
  }
  if (!res.meta.changes) return c.json({ error: "too_many_examples" }, 409);

  try {
    const source = new ByteSource(new Blob([bytes]).stream());
    const first = await source.read(Math.min(CHUNK, bytes.length));
    const key = await fileKey(await firmDek(c.env, region, firm.id, true), id);
    await bucket.put(r2Key, encryptStream(key, source, first, bytes.length).pipeThrough(new FixedLengthStream(cipherLength(bytes.length))));
  } catch (e) {
    await bucket.delete(r2Key).catch(() => {});
    await db.prepare("DELETE FROM examples WHERE firm_id = ? AND id = ?").bind(firm.id, id).run().catch(() => {});
    throw e;
  }
  return c.json({ id, mime, size: bytes.length }, 201);
});

examples.get("/examples/:id", async (c) => {
  const firm = c.get("firm");
  const row = await c.get("db")
    .prepare("SELECT id, r2_key, mime, size FROM examples WHERE firm_id = ? AND id = ?")
    .bind(firm.id, c.req.param("id"))
    .first<ExampleRow>();
  const res = row && (await sendExample(c.env, firm.region as Region, firm.id, row));
  return res || notFound(c);
});

// scoped to the link: only the example of an item that is on this request and shown to the client
examples.get("/c/:token/items/:itemId/example", async (c) => {
  if (await rateLimited(c.env, c.env.CLIENT, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  const link = await findLink(c.env, c.req.param("token"));
  if (!link) return notFound(c);
  const { db, region, req } = link;
  const row = await db
    .prepare(
      `SELECT e.id, e.r2_key, e.mime, e.size FROM items i JOIN examples e ON e.firm_id = i.firm_id AND e.id = i.example
       WHERE i.firm_id = ? AND i.request_id = ? AND i.id = ? AND ${visible("i")}`,
    )
    .bind(req.firm_id, req.id, c.req.param("itemId"))
    .first<ExampleRow>();
  const res = row && (await sendExample(c.env, region, req.firm_id, row));
  return res || notFound(c);
});
