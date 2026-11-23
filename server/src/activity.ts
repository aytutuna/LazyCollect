import { Hono, type Context } from "hono";
import { isOwner } from "./firm";
import { findRequest } from "./requests";
import type { AppEnv } from "./session";
import { invalid, notFound } from "./validate";

export const activity = new Hono<AppEnv>();

const PAGE = 50;
const COLS = "id, at, actor_type, actor_id, action, object_type, object_id, request_id";

type Row = { id: string; at: number; actor_type: string; actor_id: string | null; action: string; object_type: string; object_id: string; request_id: string | null };

// staff emails come from CONTROL, by the ids this account's own rows name, so a person who has since moved to another account stays named; the links are checked against what still exists; neither is joined in the region query
async function enrich(c: Context<AppEnv>, rows: Row[]) {
  const firmId = c.get("firm").id;
  const db = c.get("db");
  const ids = (list: (string | null)[]) => JSON.stringify([...new Set(list.filter((v): v is string => !!v))]);
  const { results: users } = await c.env.CONTROL
    .prepare("SELECT id, email FROM users WHERE id IN (SELECT value FROM json_each(?))")
    .bind(ids(rows.map((r) => r.actor_id)))
    .all<{ id: string; email: string }>();
  const target = (r: Row) => (r.object_type === "request" ? r.object_id : r.request_id);
  const { results: requests } = await db
    .prepare("SELECT id FROM requests WHERE firm_id = ? AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))")
    .bind(firmId, ids(rows.map(target)))
    .all<{ id: string }>();
  const { results: clients } = await db
    .prepare("SELECT id FROM clients WHERE firm_id = ? AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))")
    .bind(firmId, ids(rows.filter((r) => r.object_type === "client").map((r) => r.object_id)))
    .all<{ id: string }>();
  const email = new Map(users.map((u) => [u.id, u.email]));
  const liveRequests = new Set(requests.map((r) => r.id));
  const liveClients = new Set(clients.map((r) => r.id));
  return rows.map((r) => {
    const request = target(r);
    return {
      id: r.id,
      at: r.at,
      actor_type: r.actor_type,
      actor: r.actor_id ? (email.get(r.actor_id) ?? null) : null,
      action: r.action,
      object_type: r.object_type,
      object_id: r.object_id,
      request_id: request && liveRequests.has(request) ? request : null,
      client_id: r.object_type === "client" && liveClients.has(r.object_id) ? r.object_id : null,
    };
  });
}

activity.get("/activity", async (c) => {
  if (!(await isOwner(c))) return c.json({ error: "forbidden" }, 403);
  const cursor = c.req.query("cursor");
  let after: [number, string] | null = null;
  if (cursor !== undefined) {
    if (!/^\d{1,16}_[0-9a-f]{32}$/.test(cursor)) return invalid(c);
    const [at, id] = cursor.split("_");
    after = [Number(at), id];
  }
  const { results } = await c.get("db")
    .prepare(
      `SELECT ${COLS} FROM audit WHERE firm_id = ?${after ? " AND (at < ? OR (at = ? AND id < ?))" : ""}
       ORDER BY at DESC, id DESC LIMIT ${PAGE + 1}`,
    )
    .bind(c.get("firm").id, ...(after ? [after[0], after[0], after[1]] : []))
    .all<Row>();
  const page = results.slice(0, PAGE);
  const last = page[page.length - 1];
  return c.json({ rows: await enrich(c, page), next: results.length > PAGE ? `${last.at}_${last.id}` : null });
});

activity.get("/requests/:id/activity", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const { results } = await c.get("db")
    .prepare(
      `SELECT ${COLS} FROM audit WHERE firm_id = ? AND (request_id = ? OR (object_type = 'request' AND object_id = ?))
       ORDER BY at DESC, id DESC LIMIT 100`,
    )
    .bind(c.get("firm").id, req.id, req.id)
    .all<Row>();
  return c.json({ rows: await enrich(c, results) });
});
