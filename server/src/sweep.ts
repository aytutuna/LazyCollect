import { HOUR } from "./util";
import { regionIds, regionOf } from "./regions";

const BATCH = 200;

// objects of uploads that never finished and of files a client removed; soft-deleted requests are left for the retention job
export async function sweepFiles(env: Env, now = Date.now()) {
  for (const id of regionIds) {
    const { db, bucket } = regionOf(env, id);
    const { results } = await db
      .prepare(
        `SELECT id, firm_id, r2_key FROM files
         WHERE (state = 'pending' AND uploaded_at < ?) OR deleted_at IS NOT NULL LIMIT ${BATCH}`,
      )
      .bind(now - HOUR)
      .all<{ id: string; firm_id: string; r2_key: string }>();
    if (!results.length) continue;
    await bucket.delete(results.map((f) => f.r2_key));
    await db.batch(results.map((f) => db.prepare("DELETE FROM files WHERE firm_id = ? AND id = ?").bind(f.firm_id, f.id)));
  }
}
