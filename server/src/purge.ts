import { regionIds, regionOf } from "./regions";
import { RESTORE_WINDOW, randomId } from "./util";

// requests purged per region per run; a client's requests count against the same budget
const BUDGET = 20;

type Reason = "deleted" | "retention";
type Target = { id: string; firm_id: string };

async function emptyPrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

// objects go first and rows only after them, so a run that dies in between is finished by the next one
async function purgeRequest(db: D1Database, bucket: R2Bucket, req: Target, reason: Reason, now: number): Promise<number | null> {
  const held = await db.prepare("SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND hold_at IS NOT NULL").bind(req.firm_id, req.id).first();
  if (held) return null;
  const { n } = (await db.prepare("SELECT COUNT(*) AS n FROM files WHERE firm_id = ? AND request_id = ?").bind(req.firm_id, req.id).first<{ n: number }>())!;
  await emptyPrefix(bucket, `f/${req.firm_id}/${req.id}/`);
  const own = [req.firm_id, req.id] as const;
  await db.batch([
    db
      .prepare("INSERT INTO deletion_log (id, firm_id, kind, target_id, reason, files, at) VALUES (?, ?, 'request', ?, ?, ?, ?)")
      .bind(randomId(), req.firm_id, req.id, reason, n, now),
    db.prepare("DELETE FROM messages WHERE firm_id = ? AND request_id = ?").bind(...own),
    db.prepare("DELETE FROM files WHERE firm_id = ? AND request_id = ?").bind(...own),
    db.prepare("DELETE FROM items WHERE firm_id = ? AND request_id = ?").bind(...own),
    db.prepare("DELETE FROM links WHERE firm_id = ? AND request_id = ?").bind(...own),
    db.prepare("DELETE FROM requests WHERE firm_id = ? AND id = ?").bind(...own),
  ]);
  return n;
}

async function purgeClient(db: D1Database, bucket: R2Bucket, client: Target, budget: { left: number }, now: number) {
  let files = 0;
  const { results } = await db
    .prepare("SELECT id, firm_id FROM requests WHERE firm_id = ? AND client_id = ? AND hold_at IS NULL LIMIT ?")
    .bind(client.firm_id, client.id, budget.left)
    .all<Target>();
  for (const req of results) {
    files += (await purgeRequest(db, bucket, req, "deleted", now)) ?? 0;
    budget.left--;
  }
  const left = await db.prepare("SELECT 1 FROM requests WHERE firm_id = ? AND client_id = ?").bind(client.firm_id, client.id).first();
  if (left) return;
  await db.batch([
    db
      .prepare("INSERT INTO deletion_log (id, firm_id, kind, target_id, reason, files, at) VALUES (?, ?, 'client', ?, 'deleted', ?, ?)")
      .bind(randomId(), client.firm_id, client.id, files, now),
    db.prepare("DELETE FROM clients WHERE firm_id = ? AND id = ?").bind(client.firm_id, client.id),
  ]);
}

export async function purgeExpired(env: Env, now = Date.now()) {
  const cutoff = now - RESTORE_WINDOW;
  for (const id of regionIds) {
    const { db, bucket } = regionOf(env, id);
    const budget = { left: BUDGET };
    const requests = async (reason: Reason, sql: string, at: number) => {
      if (budget.left <= 0) return;
      const { results } = await db.prepare(`SELECT id, firm_id FROM requests WHERE ${sql} AND hold_at IS NULL LIMIT ?`).bind(at, budget.left).all<Target>();
      for (const req of results) {
        await purgeRequest(db, bucket, req, reason, now);
        budget.left--;
      }
    };
    await requests("deleted", "deleted_at <= ?", cutoff);
    await requests("retention", "keep_until <= ? AND deleted_at IS NULL", now);

    if (budget.left <= 0) continue;
    // a client whose requests are all on hold has nothing to purge yet and would crowd out the others
    const { results } = await db
      .prepare(
        `SELECT c.id, c.firm_id FROM clients c WHERE c.deleted_at <= ?
         AND (NOT EXISTS (SELECT 1 FROM requests WHERE firm_id = c.firm_id AND client_id = c.id AND hold_at IS NOT NULL)
           OR EXISTS (SELECT 1 FROM requests WHERE firm_id = c.firm_id AND client_id = c.id AND hold_at IS NULL))
         LIMIT ?`,
      )
      .bind(cutoff, budget.left)
      .all<Target>();
    for (const client of results) {
      if (budget.left <= 0) break;
      await purgeClient(db, bucket, client, budget, now);
    }
  }
}
