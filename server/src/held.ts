import { decryptStream, fileKey } from "./crypt";
import { openDek } from "./keys";
import { regionOf, type Region } from "./regions";
import { DAY, randomId } from "./util";

// how long a removed file stays in the bucket as an earlier version
export const HELD_FOR = 30 * DAY;

export type FileRow = {
  id: string;
  firm_id: string;
  request_id: string;
  item_id: string;
  r2_key: string;
  name: string;
  mime: string;
  size: number;
  uploaded_by: string;
  uploaded_at: number;
};

export const FILE_COLUMNS = "id, firm_id, request_id, item_id, r2_key, name, mime, size, uploaded_by, uploaded_at";

// Copies the objects into the holding place before anything deletes them. A file already held is left alone, so a run that
// stops halfway can go again; a file with no object has nothing to keep. Throws when a copy fails, so the caller doesn't delete.
export async function holdFiles(env: Env, region: Region, files: FileRow[], reason: string, now = Date.now()) {
  if (!files.length) return;
  const { db, bucket } = regionOf(env, region);
  const keys = new Map<string, string | null>();
  // a copy that has run out its 30 days doesn't count: a file removed again gets a fresh 30
  const done = await db
    .prepare("SELECT file_id FROM held_files WHERE expires_at > ? AND file_id IN (SELECT value FROM json_each(?))")
    .bind(now, JSON.stringify(files.map((f) => f.id)))
    .all<{ file_id: string }>();
  // a copy still held starts its 30 days again from this removal
  if (done.results.length) {
    await db
      .prepare("UPDATE held_files SET expires_at = ? WHERE expires_at > ? AND file_id IN (SELECT value FROM json_each(?))")
      .bind(now + HELD_FOR, now, JSON.stringify(done.results.map((r) => r.file_id)))
      .run();
  }
  const held = new Set(done.results.map((r) => r.file_id));
  for (const f of files) {
    if (held.has(f.id)) continue;
    const object = await bucket.get(f.r2_key);
    if (!object) continue;
    if (!keys.has(f.firm_id)) {
      const row = await env.CONTROL.prepare("SELECT dek_wrapped FROM firms WHERE id = ?").bind(f.firm_id).first<{ dek_wrapped: string | null }>();
      keys.set(f.firm_id, row?.dek_wrapped ?? null);
    }
    const id = randomId();
    const heldKey = `held/${f.firm_id}/${id}`;
    await bucket.put(heldKey, object.body);
    await db
      .prepare(
        `INSERT INTO held_files (id, file_id, firm_id, request_id, item_id, r2_key, held_key, name, mime, size, uploaded_by, uploaded_at, reason, dek_wrapped, held_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, f.id, f.firm_id, f.request_id, f.item_id, f.r2_key, heldKey, f.name, f.mime, f.size, f.uploaded_by, f.uploaded_at, reason, keys.get(f.firm_id), now, now + HELD_FOR)
      .run();
  }
}

// Held copies past their 30 days. The objects go first, so a failed delete leaves the row to be tried again.
export async function dropHeld(db: D1Database, bucket: R2Bucket, now: number) {
  const { results } = await db.prepare("SELECT id, held_key FROM held_files WHERE expires_at <= ? ORDER BY expires_at LIMIT 200").bind(now).all<{ id: string; held_key: string }>();
  if (!results.length) return;
  await bucket.delete(results.map((r) => r.held_key));
  await db.prepare("DELETE FROM held_files WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(results.map((r) => r.id))).run();
}

// The held file as the client sent it, decrypted with the key kept beside it.
export async function openHeld(env: Env, region: Region, heldId: string) {
  const { db, bucket } = regionOf(env, region);
  const row = await db.prepare("SELECT * FROM held_files WHERE id = ?").bind(heldId).first<FileRow & { file_id: string; held_key: string; dek_wrapped: string | null }>();
  if (!row?.dek_wrapped) return null;
  const object = await bucket.get(row.held_key);
  if (!object) return null;
  const key = await fileKey(await openDek(env, region, row.dek_wrapped, row.firm_id), row.file_id);
  return { row, body: await decryptStream(key, object.body) };
}

// Puts a held file back where it was, as a live file on its item. Null when the item is gone too.
export async function restoreHeld(env: Env, region: Region, heldId: string): Promise<"restored" | "no_item" | "missing"> {
  const { db, bucket } = regionOf(env, region);
  const row = await db.prepare("SELECT * FROM held_files WHERE id = ?").bind(heldId).first<FileRow & { file_id: string; held_key: string }>();
  if (!row) return "missing";
  const object = await bucket.get(row.held_key);
  if (!object) return "missing";
  const item = await db.prepare("SELECT 1 FROM items WHERE firm_id = ? AND request_id = ? AND id = ?").bind(row.firm_id, row.request_id, row.item_id).first();
  if (!item) return "no_item";
  await bucket.put(row.r2_key, object.body);
  await db.batch([
    db.prepare("UPDATE files SET deleted_at = NULL, state = 'live' WHERE firm_id = ? AND id = ?").bind(row.firm_id, row.file_id),
    db
      .prepare(
        `INSERT INTO files (id, firm_id, request_id, item_id, r2_key, name, mime, size, upload_id, uploaded_by, uploaded_at, state)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'live' WHERE NOT EXISTS (SELECT 1 FROM files WHERE firm_id = ?2 AND id = ?1)`,
      )
      .bind(row.file_id, row.firm_id, row.request_id, row.item_id, row.r2_key, row.name, row.mime, row.size, randomId(), row.uploaded_by, row.uploaded_at),
    db.prepare("UPDATE items SET status = 'submitted' WHERE firm_id = ? AND request_id = ? AND id = ? AND status = 'empty'").bind(row.firm_id, row.request_id, row.item_id),
  ]);
  return "restored";
}
