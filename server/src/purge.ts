import { LINK_GRACE } from "./links";
import { regionIds, regionOf } from "./regions";
import { DEFAULT_YEARS, YEAR } from "./status";
import { HOUR, RESTORE_WINDOW, randomId } from "./util";

// requests purged per region per run; a client's requests count against the same budget
const BUDGET = 20;
const RETENTION_BATCH = 50;

type Reason = "deleted" | "retention" | "closed";
type Target = { id: string; firm_id: string; deleted_reason?: string | null; deleted_with_account?: number };

// the request's own reason for going; the column is separate because deleted_reason's check can't be widened without rebuilding the table
export const reasonOf = (r: Target): Reason => (r.deleted_reason === "retention" ? "retention" : r.deleted_with_account ? "closed" : "deleted");

// A request is only retired once it is closed or its link has run out, so a live link is never cut. Takes the time once.
export const FINISHED = `ended_at IS NOT NULL AND hold_at IS NULL AND deleted_at IS NULL AND purging_at IS NULL
  AND (status = 'closed' OR deadline + ${LINK_GRACE} <= ?)`;

const log = (e: unknown) => console.error(e instanceof Error ? e.message : "error");

export async function emptyPrefix(bucket: R2Bucket, prefix: string, onDelete?: () => void) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) {
      onDelete?.();
      await bucket.delete(page.objects.map((o) => o.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

// Claim first, so restore and hold back off; objects go before rows, so a run that dies in between is finished by the next one.
export async function purgeRequest(db: D1Database, bucket: R2Bucket, req: Target, reason: Reason, now: number, cutoff: number): Promise<number | null> {
  const claim = await db
    .prepare(
      `UPDATE requests SET purging_at = ? WHERE firm_id = ? AND id = ? AND hold_at IS NULL AND (purging_at IS NULL OR purging_at < ?)
       AND (deleted_at <= ? OR client_id IN (SELECT id FROM clients WHERE firm_id = requests.firm_id AND deleted_at <= ?))`,
    )
    .bind(now, req.firm_id, req.id, now - HOUR, cutoff, cutoff)
    .run();
  if (!claim.meta.changes) return null;
  // once an object is gone the claim stays, so the stale-claim retry finishes the job
  let touched = false;
  try {
    const prefix = `f/${req.firm_id}/${req.id}/`;
    const { n } = (await db.prepare("SELECT COUNT(*) AS n FROM files WHERE firm_id = ? AND request_id = ?").bind(req.firm_id, req.id).first<{ n: number }>())!;
    await emptyPrefix(bucket, prefix, () => (touched = true));
    const own = [req.firm_id, req.id] as const;
    const mine = "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND purging_at = ?)";
    const held = [...own, now] as const;
    await db.batch([
      db
        .prepare(
          `INSERT INTO deletion_log (id, firm_id, kind, target_id, reason, files, at)
           SELECT ?, ?, 'request', ?, ?, ?, ? WHERE ${mine}`,
        )
        .bind(randomId(), req.firm_id, req.id, reason, n, now, ...held),
      db
        .prepare(
          `INSERT OR IGNORE INTO message_log (id, firm_id, request_id, client_id, channel, kind, seq, template_version, body_hash, status, sent_at)
           SELECT id, firm_id, request_id, client_id, channel, kind, seq, template_version, body_hash, status, sent_at
           FROM messages WHERE firm_id = ? AND request_id = ? AND ${mine}`,
        )
        .bind(...own, ...held),
      db.prepare(`DELETE FROM messages WHERE firm_id = ? AND request_id = ? AND ${mine}`).bind(...own, ...held),
      db.prepare(`DELETE FROM notes WHERE firm_id = ? AND request_id = ? AND ${mine}`).bind(...own, ...held),
      // the audit trail stays, but what a document was sent back for is client data
      db.prepare(`UPDATE audit SET meta = json_remove(meta, '$.reasons') WHERE firm_id = ? AND request_id = ? AND action = 'item.review' AND ${mine}`).bind(...own, ...held),
      db.prepare(`DELETE FROM files WHERE firm_id = ? AND request_id = ? AND ${mine}`).bind(...own, ...held),
      db.prepare(`DELETE FROM items WHERE firm_id = ? AND request_id = ? AND ${mine}`).bind(...own, ...held),
      db.prepare(`DELETE FROM links WHERE firm_id = ? AND request_id = ? AND ${mine}`).bind(...own, ...held),
      db
        .prepare(
          `DELETE FROM batches WHERE firm_id = ? AND id IN (SELECT batch_id FROM batch_items WHERE firm_id = ? AND request_id = ?)
           AND NOT EXISTS (SELECT 1 FROM batch_items WHERE firm_id = batches.firm_id AND batch_id = batches.id AND request_id != ?) AND ${mine}`,
        )
        .bind(req.firm_id, ...own, req.id, ...held),
      db.prepare(`DELETE FROM batch_items WHERE firm_id = ? AND request_id = ? AND ${mine}`).bind(...own, ...held),
      db.prepare("DELETE FROM requests WHERE firm_id = ? AND id = ? AND purging_at = ?").bind(...held),
    ]);
    // an upload that was already in flight can land after the first pass
    await emptyPrefix(bucket, prefix);
    return n;
  } catch (e) {
    await db
      .prepare(`UPDATE requests SET ${touched ? "" : "purging_at = NULL, "}purge_failed_at = ? WHERE firm_id = ? AND id = ? AND purging_at = ?`)
      .bind(now, req.firm_id, req.id, now)
      .run()
      .catch(log);
    throw e;
  }
}

async function purgeClient(db: D1Database, bucket: R2Bucket, client: Target, budget: { left: number }, now: number, cutoff: number) {
  let files = 0;
  const { results } = await db
    .prepare(
      `SELECT id, firm_id, deleted_reason, deleted_with_account FROM requests WHERE firm_id = ? AND client_id = ? AND hold_at IS NULL AND (purge_failed_at IS NULL OR purge_failed_at < ?)
       ORDER BY COALESCE(purge_failed_at, 0), created_at LIMIT ?`,
    )
    .bind(client.firm_id, client.id, now - HOUR, budget.left)
    .all<Target>();
  let failed = false;
  for (const req of results) {
    budget.left--;
    try {
      files += (await purgeRequest(db, bucket, req, reasonOf(req), now, cutoff)) ?? 0;
    } catch (e) {
      log(e);
      failed = true;
    }
  }
  if (failed) {
    await db.prepare("UPDATE clients SET purge_failed_at = ? WHERE firm_id = ? AND id = ?").bind(now, client.firm_id, client.id).run();
    return;
  }
  const none = "deleted_at <= ? AND NOT EXISTS (SELECT 1 FROM requests WHERE firm_id = clients.firm_id AND client_id = clients.id)";
  await db.batch([
    db
      .prepare(
        `INSERT INTO deletion_log (id, firm_id, kind, target_id, reason, files, at)
         SELECT ?, ?, 'client', ?, 'deleted', ?, ? WHERE EXISTS (SELECT 1 FROM clients WHERE firm_id = ? AND id = ? AND ${none})`,
      )
      .bind(randomId(), client.firm_id, client.id, files, now, client.firm_id, client.id, cutoff),
    db.prepare(`DELETE FROM clients WHERE firm_id = ? AND id = ? AND ${none}`).bind(client.firm_id, client.id, cutoff),
  ]);
}

// An open request whose link has run out is finished too: its retention clock starts then, as it does on close or completion.
async function startClocks(db: D1Database, now: number) {
  const ends = `deadline + ${LINK_GRACE}`;
  await db
    .prepare(
      `UPDATE requests SET ended_at = ${ends},
         keep_until = ${ends} + COALESCE((SELECT retention_years FROM firm_settings WHERE firm_id = requests.firm_id), ${DEFAULT_YEARS}) * ${YEAR}
       WHERE rowid IN (SELECT rowid FROM requests WHERE status = 'open' AND ended_at IS NULL AND deleted_at IS NULL AND ${ends} <= ? LIMIT ${RETENTION_BATCH})`,
    )
    .bind(now)
    .run();
}

// retention only moves a request to Recently deleted; the purge below takes it after the restore window
async function retire(db: D1Database, now: number) {
  const { results } = await db
    .prepare(
      `SELECT id, firm_id FROM requests WHERE keep_until <= ? AND ${FINISHED} AND (purge_failed_at IS NULL OR purge_failed_at < ?)
       ORDER BY COALESCE(purge_failed_at, 0), keep_until LIMIT ?`,
    )
    .bind(now, now, now - HOUR, RETENTION_BATCH)
    .all<Target>();
  for (const req of results) {
    try {
      const done = "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND deleted_at = ? AND deleted_reason = 'retention')";
      await db.batch([
        db
          .prepare(`UPDATE requests SET deleted_at = ?, deleted_reason = 'retention' WHERE firm_id = ? AND id = ? AND keep_until <= ? AND ${FINISHED}`)
          .bind(now, req.firm_id, req.id, now, now),
        db
          .prepare(`UPDATE links SET revoked_at = ? WHERE firm_id = ? AND request_id = ? AND revoked_at IS NULL AND ${done}`)
          .bind(now, req.firm_id, req.id, req.firm_id, req.id, now),
        db
          .prepare(
            `INSERT INTO audit (id, firm_id, at, actor_type, action, object_type, object_id)
             SELECT ?, ?, ?, 'system', 'request.retention_delete', 'request', ? WHERE ${done}`,
          )
          .bind(randomId(), req.firm_id, now, req.id, req.firm_id, req.id, now),
      ]);
    } catch (e) {
      log(e);
      await db.prepare("UPDATE requests SET purge_failed_at = ? WHERE firm_id = ? AND id = ?").bind(now, req.firm_id, req.id).run().catch(log);
    }
  }
}

export async function purgeExpired(env: Env, now = Date.now()) {
  const cutoff = now - RESTORE_WINDOW;
  for (const id of regionIds) {
    try {
      const { db, bucket } = regionOf(env, id);
      await startClocks(db, now).catch(log);
      await retire(db, now).catch(log);

      const budget = { left: BUDGET };
      const { results } = await db
        .prepare(
          `SELECT id, firm_id, deleted_reason, deleted_with_account FROM requests WHERE deleted_at <= ? AND hold_at IS NULL AND (purging_at IS NULL OR purging_at < ?)
           AND (purge_failed_at IS NULL OR purge_failed_at < ?) ORDER BY COALESCE(purge_failed_at, 0), deleted_at LIMIT ?`,
        )
        .bind(cutoff, now - HOUR, now - HOUR, budget.left)
        .all<Target>();
      for (const req of results) {
        budget.left--;
        await purgeRequest(db, bucket, req, reasonOf(req), now, cutoff).catch(log);
      }

      if (budget.left <= 0) continue;
      // a client whose requests are all on hold has nothing to purge yet and would crowd out the others
      const clients = await db
        .prepare(
          `SELECT c.id, c.firm_id FROM clients c WHERE c.deleted_at <= ? AND (c.purge_failed_at IS NULL OR c.purge_failed_at < ?)
           AND (NOT EXISTS (SELECT 1 FROM requests WHERE firm_id = c.firm_id AND client_id = c.id AND hold_at IS NOT NULL)
             OR EXISTS (SELECT 1 FROM requests WHERE firm_id = c.firm_id AND client_id = c.id AND hold_at IS NULL))
           ORDER BY COALESCE(c.purge_failed_at, 0), c.deleted_at LIMIT ?`,
        )
        .bind(cutoff, now - HOUR, budget.left)
        .all<Target>();
      for (const client of clients.results) {
        if (budget.left <= 0) break;
        await purgeClient(db, bucket, client, budget, now, cutoff).catch(log);
      }
    } catch (e) {
      log(e);
    }
  }
}
