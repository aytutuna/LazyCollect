import { Hono } from "hono";
import { rateLimited } from "./auth";
import { auditClient } from "./audit";
import { linkOf } from "./client";
import { ByteSource, CHUNK, cipherLength, encryptStream, fileKey } from "./crypt";
import { planUsable } from "./firm";
import { holdFiles, type FileRow as HeldFile } from "./held";
import { TYPES, familyOf, inspect, kindOf, parseKinds, passwordProtected } from "./kinds";
import { firmDek } from "./keys";
import { regionOf } from "./regions";
import type { AppEnv } from "./session";
import { syncStatus } from "./status";
import { hmac, ipPrefix, keyLimited, randomId } from "./util";
import { invalid, notFound } from "./validate";

export const uploads = new Hono<AppEnv>();

const MAX_SIZE = 25 * 1024 * 1024;
const MAX_PER_ITEM = 20;
const MAX_PER_REQUEST = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"];

export function sniff(b: Uint8Array): string | null {
  const at = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (at(0, 5) === "%PDF-") return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (at(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (at(0, 4) === "RIFF" && at(8, 12) === "WEBP") return "image/webp";
  if (at(4, 8) === "ftyp") {
    const brand = at(8, 12);
    if (HEIC_BRANDS.includes(brand)) return "image/heic";
    if (brand === "mif1" || brand === "msf1") return "image/heif";
  }
  return null;
}

// a display name only: it never becomes a path, and its extension always matches the sniffed type
function cleanName(raw: string, mime: string): string {
  let name = raw
    .normalize("NFC")
    .replace(/[\p{C}]/gu, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const fitting = (n: string) => n.lastIndexOf(".") > 0 && TYPES[mime].includes(n.slice(n.lastIndexOf(".") + 1).toLowerCase());
  // "T4.pdf.html" sniffed as a pdf loses ".html"; a name still without a fitting extension gets one
  if (!fitting(name)) name = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const fits = fitting(name);
  const dot = name.lastIndexOf(".");
  const ext = fits ? name.slice(dot) : `.${TYPES[mime][0]}`;
  const stem = fits ? name.slice(0, dot) : name;
  const base = Array.from(stem).slice(0, 200 - ext.length).join("").trim();
  return base ? `${base}${ext}` : `file.${TYPES[mime][0]}`;
}

type FileRow = { id: string; name: string; size: number; uploaded_at: number };

uploads.put("/c/:token/items/:itemId/files", async (c) => {
  const ip = c.req.header("CF-Connecting-IP");
  if (await rateLimited(c.env, c.env.CLIENT, ip)) return c.json({ error: "rate_limited" }, 429);
  const link = await linkOf(c);
  if (!link || (link.req.status !== "open" && link.req.status !== "complete")) return notFound(c);
  if (await keyLimited(c.env.UPLOAD, link.hash)) return c.json({ error: "rate_limited" }, 429);
  const { db, region, req } = link;

  const lengthHeader = c.req.header("Content-Length");
  if (lengthHeader === undefined) return c.json({ error: "length_required" }, 411);
  const length = /^\d{1,12}$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
  if (Number.isNaN(length)) return invalid(c);
  if (length > MAX_SIZE) return c.json({ error: "too_big" }, 413);
  const uploadId = c.req.header("Upload-Id")?.toLowerCase();
  if (!uploadId || !UUID_RE.test(uploadId)) return invalid(c);
  let rawName = "";
  try {
    rawName = decodeURIComponent(c.req.header("X-File-Name") ?? "");
  } catch {
    return invalid(c);
  }

  const itemId = c.req.param("itemId");
  const item = await db
    .prepare("SELECT status FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND kind = 'file'")
    .bind(req.firm_id, req.id, itemId)
    .first<{ status: string }>();
  if (!item) return notFound(c);
  const findUpload = () =>
    db
      .prepare("SELECT id, name, size, uploaded_at, deleted_at, state FROM files WHERE firm_id = ? AND item_id = ? AND upload_id = ?")
      .bind(req.firm_id, itemId, uploadId)
      .first<FileRow & { deleted_at: number | null; state: string }>();
  const replay = async () => {
    const f = await findUpload();
    if (!f) return null;
    if (f.deleted_at !== null) return c.json({ error: "upload_id_used" }, 409);
    if (f.state === "pending") return c.json({ error: "busy" }, 409);
    return c.json({ id: f.id, name: f.name, size: f.size, uploaded_at: f.uploaded_at });
  };
  const earlier = await replay();
  if (earlier) return earlier;
  if (item.status === "approved") return c.json({ error: "approved" }, 409);
  if (!(await planUsable(c.env, req.firm_id, Date.now()))) return c.json({ error: "paused" }, 402);
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM files WHERE firm_id = ?1 AND item_id = ?2 AND deleted_at IS NULL) AS item,
              (SELECT COUNT(*) FROM files WHERE firm_id = ?1 AND request_id = ?3 AND deleted_at IS NULL) AS req`,
    )
    .bind(req.firm_id, itemId, req.id)
    .first<{ item: number; req: number }>();
  if (counts!.item >= MAX_PER_ITEM || counts!.req >= MAX_PER_REQUEST) return c.json({ error: "limit" }, 409);

  // nothing is written until the first bytes have been looked at
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "unsupported_type" }, 415);
  const settings = await db.prepare("SELECT file_kinds FROM firm_settings WHERE firm_id = ?").bind(req.firm_id).first<{ file_kinds: string | null }>();
  let source = new ByteSource(body);
  let first = await source.read(Math.min(CHUNK, length));
  let mime = sniff(first);
  if (!mime) {
    const family = familyOf(first, rawName);
    if (!family) return c.json({ error: "unsupported_type" }, 415);
    // office, open document and text files are read whole: a zip lists its parts at the end, and macros hide inside
    const whole = new Uint8Array(length);
    whole.set(first);
    for (let at = first.length; at < length; ) {
      const piece = await source.read(Math.min(CHUNK, length - at));
      if (!piece.length) return invalid(c);
      whole.set(piece, at);
      at += piece.length;
    }
    if (family === "old") return c.json({ error: passwordProtected(whole) ? "encrypted_office" : "old_office" }, 415);
    const found = await inspect(family, whole, rawName);
    if (found === "macros") return c.json({ error: "macros" }, 415);
    if (!found) return c.json({ error: "unsupported_type" }, 415);
    mime = found;
    first = whole.subarray(0, Math.min(CHUNK, length));
    const tail = whole.subarray(first.length);
    source = new ByteSource(new ReadableStream({ start: (s) => (s.enqueue(tail), s.close()) }));
  }
  if (!parseKinds(settings?.file_kinds).includes(kindOf(mime)!)) return c.json({ error: "type_off" }, 415);

  const fileId = randomId();
  const key = await fileKey(await firmDek(c.env, region, req.firm_id, true), fileId);
  const bucket = regionOf(c.env, region).bucket;
  const r2Key = `f/${req.firm_id}/${req.id}/${fileId}`;
  const now = Date.now();
  const name = cleanName(rawName, mime);
  const ipHash = await hmac(c.env.HASH_KEY, ipPrefix(ip ?? "unknown"));
  const here = [req.firm_id, fileId];

  // the row exists before the object does, so a crash between the two leaves something the sweep can find
  const reserved = await db
    .prepare(
      `INSERT INTO files (id, firm_id, request_id, item_id, r2_key, name, mime, size, upload_id, uploaded_by, uploaded_at, state)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'client', ?, 'pending'
       WHERE EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL)
       AND EXISTS (SELECT 1 FROM links WHERE token_hash = ? AND revoked_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM firm_settings WHERE firm_id = ? AND closed_at IS NOT NULL)
       AND EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND status != 'approved')
       AND (SELECT COUNT(*) FROM files WHERE firm_id = ? AND item_id = ? AND deleted_at IS NULL) < ${MAX_PER_ITEM}
       AND (SELECT COUNT(*) FROM files WHERE firm_id = ? AND request_id = ? AND deleted_at IS NULL) < ${MAX_PER_REQUEST}
       ON CONFLICT (firm_id, item_id, upload_id) DO NOTHING`,
    )
    .bind(
      fileId, req.firm_id, req.id, itemId, r2Key, name, mime, length, uploadId, now,
      req.firm_id, req.id,
      link.hash,
      req.firm_id,
      req.firm_id, req.id, itemId,
      req.firm_id, itemId,
      req.firm_id, req.id,
    )
    .run();

  const refusal = async () => {
    const again = await replay();
    if (again) return again;
    const open = await linkOf(c);
    if (!open || (open.req.status !== "open" && open.req.status !== "complete")) return notFound(c);
    const state = await db
      .prepare("SELECT status FROM items WHERE firm_id = ? AND request_id = ? AND id = ?")
      .bind(req.firm_id, req.id, itemId)
      .first<{ status: string }>();
    if (!state) return notFound(c);
    return c.json({ error: state.status === "approved" ? "approved" : "limit" }, 409);
  };
  if (!reserved.meta.changes) return refusal();

  const forget = async () => {
    await bucket.delete(r2Key).catch(() => {});
    await db.prepare("DELETE FROM files WHERE firm_id = ? AND id = ? AND state = 'pending'").bind(...here).run().catch(() => {});
  };
  try {
    await bucket.put(r2Key, encryptStream(key, source, first, length).pipeThrough(new FixedLengthStream(cipherLength(length))));
  } catch (e) {
    await forget();
    throw e;
  }

  let done: D1Result | undefined;
  try {
    [done] = await db.batch([
      db
        .prepare(
          `UPDATE files SET state = 'live', uploaded_at = ? WHERE firm_id = ? AND id = ? AND state = 'pending'
           AND EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL)
           AND EXISTS (SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ? AND status != 'approved')`,
        )
        .bind(Date.now(), ...here, req.firm_id, req.id, req.firm_id, req.id, itemId),
      db
        .prepare(
          `UPDATE items SET status = 'submitted' WHERE firm_id = ? AND request_id = ? AND id = ? AND status IN ('empty', 'rejected', 'unavailable', 'waived')
           AND EXISTS (SELECT 1 FROM files WHERE firm_id = ? AND id = ? AND state = 'live')`,
        )
        .bind(req.firm_id, req.id, itemId, ...here),
      syncStatus(db, req.firm_id, req.id),
      db
        .prepare(
          `UPDATE requests SET notice_due_at = COALESCE(notice_due_at, ?) WHERE firm_id = ? AND id = ?
           AND EXISTS (SELECT 1 FROM files WHERE firm_id = ? AND id = ? AND state = 'live')`,
        )
        .bind(Date.now(), req.firm_id, req.id, ...here),
      auditClient(db, req.firm_id, ipHash, "file.upload", "file", fileId, { request: req.id, item: itemId, size: length, mime }, {
        sql: "EXISTS (SELECT 1 FROM files WHERE firm_id = ? AND id = ? AND state = 'live')",
        binds: here,
      }),
    ]);
  } catch (e) {
    // the batch may have committed before the error reached us; only drop what is still pending
    const row = await db.prepare("SELECT state FROM files WHERE firm_id = ? AND id = ?").bind(...here).first<{ state: string }>();
    if (row?.state !== "live") {
      await forget();
      throw e;
    }
  }

  if (done && !done.meta.changes) {
    await forget();
    return refusal();
  }
  const stored = await db.prepare("SELECT uploaded_at FROM files WHERE firm_id = ? AND id = ?").bind(...here).first<{ uploaded_at: number }>();
  return c.json({ id: fileId, name, size: length, uploaded_at: stored!.uploaded_at }, 201);
});

uploads.delete("/c/:token/files/:fileId", async (c) => {
  if (await rateLimited(c.env, c.env.CLIENT, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  const link = await linkOf(c);
  if (!link || (link.req.status !== "open" && link.req.status !== "complete")) return notFound(c);
  const { db, region, req } = link;
  const fileId = c.req.param("fileId");
  const file = await db
    .prepare(
      `SELECT f.id, f.firm_id, f.request_id, f.item_id, f.r2_key, f.name, f.mime, f.size, f.uploaded_by, f.uploaded_at, i.status FROM files f JOIN items i ON i.firm_id = f.firm_id AND i.request_id = f.request_id AND i.id = f.item_id
       WHERE f.firm_id = ? AND f.request_id = ? AND f.id = ? AND f.uploaded_by = 'client' AND f.state = 'live' AND f.deleted_at IS NULL`,
    )
    .bind(req.firm_id, req.id, fileId)
    .first<HeldFile & { status: string }>();
  if (!file) return notFound(c);
  if (file.status === "approved") return c.json({ error: "approved" }, 409);
  const held = "EXISTS (SELECT 1 FROM requests WHERE firm_id = files.firm_id AND id = files.request_id AND hold_at IS NOT NULL)";
  if (await db.prepare("SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND hold_at IS NOT NULL").bind(req.firm_id, req.id).first()) {
    return c.json({ error: "legal_hold" }, 409);
  }

  const now = Date.now();
  const live = "firm_id = ? AND id = ? AND state = 'live' AND deleted_at IS NULL AND NOT " + held + " AND EXISTS (SELECT 1 FROM items WHERE firm_id = files.firm_id AND id = files.item_id AND status != 'approved')";
  const binds = [req.firm_id, fileId];
  const ipHash = await hmac(c.env.HASH_KEY, ipPrefix(c.req.header("CF-Connecting-IP") ?? "unknown"));
  // the audit row goes first: its condition reads the file the next statement marks deleted
  const [, marked] = await db.batch([
    auditClient(db, req.firm_id, ipHash, "file.delete", "file", fileId, { request: req.id, item: file.item_id }, {
      sql: `EXISTS (SELECT 1 FROM files WHERE ${live})`,
      binds,
    }),
    db.prepare(`UPDATE files SET deleted_at = ? WHERE ${live}`).bind(now, ...binds),
    db
      .prepare(
        `UPDATE items SET status = 'empty' WHERE firm_id = ? AND request_id = ? AND id = ? AND status IN ('submitted', 'rejected')
         AND NOT EXISTS (SELECT 1 FROM files WHERE firm_id = ? AND item_id = ? AND deleted_at IS NULL)`,
      )
      .bind(req.firm_id, req.id, file.item_id, req.firm_id, file.item_id),
    syncStatus(db, req.firm_id, req.id),
  ]);
  if (!marked.meta.changes) {
    const onHold = await db.prepare("SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND hold_at IS NOT NULL").bind(req.firm_id, req.id).first();
    return c.json({ error: onHold ? "legal_hold" : "approved" }, 409);
  }
  // a failed copy or delete leaves the object where it is; the sweep copies and removes the objects of deleted rows
  await holdFiles(c.env, region, [file], "removed")
    .then(() => regionOf(c.env, region).bucket.delete(file.r2_key))
    .catch((e) => console.error(e instanceof Error ? e.message : "error"));
  return c.json({ ok: true });
});
