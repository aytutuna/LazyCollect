import { DAY, HOUR } from "./util";
import { dropUnused } from "./examples";
import { FILE_COLUMNS, dropHeld, holdFiles, type FileRow } from "./held";
import { regionIds, regionOf } from "./regions";

const BATCH = 200;

// unfinished uploads, and files removed that no legal hold keeps
const DUE = `(state = 'pending' AND uploaded_at < ?1)
  OR (deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.firm_id = files.firm_id AND r.id = files.request_id AND r.hold_at IS NOT NULL))`;

// objects of uploads that never finished and of files a client removed (kept while the request is on legal hold), and examples no item or template uses; soft-deleted requests are left for the retention job
export async function sweepFiles(env: Env, now = Date.now()) {
  for (const id of regionIds) {
    const { db, bucket } = regionOf(env, id);
    // One set of rows is chosen, the removed files among them are copied to the holding place, and that same set goes, rows and
    // objects. Unfinished uploads have nothing to keep.
    const { results: due } = await db
      .prepare(`SELECT rowid AS at, ${FILE_COLUMNS}, deleted_at FROM files WHERE (${DUE}) LIMIT ${BATCH}`)
      .bind(now - HOUR)
      .all<FileRow & { at: number; deleted_at: number | null }>();
    await holdFiles(env, id, due.filter((f) => f.deleted_at !== null), "removed", now);
    const { results } = await db
      .prepare(`DELETE FROM files WHERE (${DUE}) AND rowid IN (SELECT value FROM json_each(?)) RETURNING r2_key`)
      .bind(now - HOUR, JSON.stringify(due.map((f) => f.at)))
      .all<{ r2_key: string }>();
    if (results.length) await bucket.delete(results.map((f) => f.r2_key));
    await dropUnused(db, bucket, now - DAY);
    await dropHeld(db, bucket, now);
  }
}
