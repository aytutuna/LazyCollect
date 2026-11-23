import { DAY, HOUR } from "./util";
import { dropUnused } from "./examples";
import { regionIds, regionOf } from "./regions";

const BATCH = 200;

// objects of uploads that never finished and of files a client removed (kept while the request is on legal hold), and examples no item or template uses; soft-deleted requests are left for the retention job
export async function sweepFiles(env: Env, now = Date.now()) {
  for (const id of regionIds) {
    const { db, bucket } = regionOf(env, id);
    // the rows go first, guarded against a hold set meanwhile, and only the objects of rows that went are deleted
    const due = `(state = 'pending' AND uploaded_at < ?)
      OR (deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.firm_id = files.firm_id AND r.id = files.request_id AND r.hold_at IS NOT NULL))`;
    const { results } = await db
      .prepare(`DELETE FROM files WHERE (${due}) AND rowid IN (SELECT rowid FROM files WHERE ${due} LIMIT ${BATCH}) RETURNING r2_key`)
      .bind(now - HOUR, now - HOUR)
      .all<{ r2_key: string }>();
    if (results.length) await bucket.delete(results.map((f) => f.r2_key));
    await dropUnused(db, bucket, now - DAY);
  }
}
