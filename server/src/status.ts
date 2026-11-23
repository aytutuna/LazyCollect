import { visible } from "./questions";

// An open request is complete once every shown required item is submitted, approved or waived and some item has a live file,
// an answer or was waived, and goes back when that stops being true. An item the client has no document for waits for the
// account's answer before it counts. A hidden item (its yes/no or choice question says it does not apply) is never missing.
const DONE = `(EXISTS (SELECT 1 FROM files WHERE firm_id = requests.firm_id AND request_id = requests.id AND state = 'live' AND deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM items WHERE firm_id = requests.firm_id AND request_id = requests.id AND (status = 'waived' OR (kind != 'file' AND status IN ('submitted', 'approved')))))
  AND NOT EXISTS (SELECT 1 FROM items i WHERE i.firm_id = requests.firm_id AND i.request_id = requests.id AND i.required = 1 AND i.status NOT IN ('submitted', 'approved', 'waived') AND ${visible("i")})`;

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
