// An open request is complete once every required item is submitted or approved, and goes back when that stops being true.
const DONE = `EXISTS (SELECT 1 FROM items WHERE firm_id = requests.firm_id AND request_id = requests.id)
  AND NOT EXISTS (SELECT 1 FROM items WHERE firm_id = requests.firm_id AND request_id = requests.id AND required = 1 AND status NOT IN ('submitted', 'approved'))`;

export function syncStatus(db: D1Database, firmId: string, requestId: string) {
  return db
    .prepare(
      `UPDATE requests SET status = CASE WHEN ${DONE} THEN 'complete' ELSE 'open' END
       WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL`,
    )
    .bind(firmId, requestId);
}
