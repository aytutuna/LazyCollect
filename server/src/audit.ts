import type { Context } from "hono";
import type { AppEnv } from "./session";
import { isRegion, regionOf } from "./regions";
import { randomId } from "./util";

// `when` makes the row depend on the same state the write in its batch acts on
export function audit(c: Context<AppEnv>, action: string, objectType: string, objectId: string, meta?: object, when?: { sql: string; binds: unknown[] }) {
  return c.get("db")
    .prepare(
      `INSERT INTO audit (id, firm_id, at, actor_type, actor_id, action, object_type, object_id, meta)
       SELECT ?, ?, ?, 'user', ?, ?, ?, ?, ?${when ? ` WHERE ${when.sql}` : ""}`,
    )
    .bind(
      randomId(),
      c.get("firm").id,
      Date.now(),
      c.get("session")!.userId,
      action,
      objectType,
      objectId,
      meta ? JSON.stringify(meta) : null,
      ...(when?.binds ?? []),
    );
}

// client actions write into the region database straight from a link, with no firm user
export function auditClient(db: D1Database, firmId: string, ipHash: string, action: string, objectType: string, objectId: string, meta: object, when: { sql: string; binds: unknown[] }) {
  return db
    .prepare(
      `INSERT INTO audit (id, firm_id, at, actor_type, action, object_type, object_id, ip_hash, meta)
       SELECT ?, ?, ?, 'client', ?, ?, ?, ?, ? WHERE ${when.sql}`,
    )
    .bind(randomId(), firmId, Date.now(), action, objectType, objectId, ipHash, JSON.stringify(meta), ...when.binds);
}

// for steps taken before a session exists, so there is no firm in the context
export async function auditLogin(env: Env, firmId: string, userId: string, action: string, objectType: string, objectId: string, meta?: object) {
  const firm = await env.CONTROL.prepare("SELECT region FROM firms WHERE id = ?").bind(firmId).first<{ region: string }>();
  if (!firm || !isRegion(firm.region)) return;
  await regionOf(env, firm.region)
    .db.prepare("INSERT INTO audit (id, firm_id, at, actor_type, actor_id, action, object_type, object_id, meta) VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)")
    .bind(randomId(), firmId, Date.now(), userId, action, objectType, objectId, meta ? JSON.stringify(meta) : null)
    .run();
}
