// An open request is complete once every required item is submitted or approved and some item has a live file, and goes back when that stops being true.
const DONE = `EXISTS (SELECT 1 FROM files WHERE firm_id = requests.firm_id AND request_id = requests.id AND state = 'live' AND deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM items WHERE firm_id = requests.firm_id AND request_id = requests.id AND required = 1 AND status NOT IN ('submitted', 'approved'))`;

export const YEAR = 31_557_600_000;
export const DEFAULT_YEARS = 7;

// SET fragment for a request entering a finished state: the clock starts once and keeps its first start
export const endNow = `ended_at = COALESCE(ended_at, ?),
  keep_until = COALESCE(ended_at, ?) + COALESCE((SELECT retention_years FROM firm_settings WHERE firm_id = requests.firm_id), ${DEFAULT_YEARS}) * ${YEAR}`;

export function syncStatus(db: D1Database, firmId: string, requestId: string, now = Date.now()) {
  return db
    .prepare(
      `UPDATE requests SET status = CASE WHEN ${DONE} THEN 'complete' ELSE 'open' END,
         ended_at = CASE WHEN ${DONE} THEN COALESCE(ended_at, ?) ELSE NULL END,
         keep_until = CASE WHEN ${DONE} THEN COALESCE(ended_at, ?) + COALESCE((SELECT retention_years FROM firm_settings WHERE firm_id = requests.firm_id), ${DEFAULT_YEARS}) * ${YEAR} ELSE NULL END
       WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL`,
    )
    .bind(now, now, firmId, requestId);
}
