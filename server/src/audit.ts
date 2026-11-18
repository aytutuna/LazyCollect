import type { Context } from "hono";
import type { AppEnv } from "./session";
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
