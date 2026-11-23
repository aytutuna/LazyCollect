import { Hono } from "hono";
import { audit } from "./audit";
import type { AppEnv } from "./session";
import { DEFAULT_YEARS, YEAR } from "./status";
import { RESTORE_WINDOW } from "./util";
import { notFound } from "./validate";

export const trash = new Hono<AppEnv>();

trash.get("/trash", async (c) => {
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const since = Date.now() - RESTORE_WINDOW;
  const { results: requests } = await db
    .prepare(
      `SELECT r.id, r.title, cl.name AS client_name, r.deleted_at, r.deleted_reason, r.deleted_at + ? AS purge_at FROM requests r
       JOIN clients cl ON cl.firm_id = r.firm_id AND cl.id = r.client_id
       WHERE r.firm_id = ? AND r.deleted_at > ? AND r.purging_at IS NULL ORDER BY r.deleted_at DESC, r.rowid DESC`,
    )
    .bind(RESTORE_WINDOW, firmId, since)
    .all();
  const { results: clients } = await db
    .prepare("SELECT id, name, deleted_at, deleted_at + ? AS purge_at FROM clients WHERE firm_id = ? AND deleted_at > ? ORDER BY deleted_at DESC, rowid DESC")
    .bind(RESTORE_WINDOW, firmId, since)
    .all();
  return c.json({ requests, clients });
});

// a restored request stays closed: its link was revoked when it was deleted
trash.post("/requests/:id/restore", async (c) => {
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const id = c.req.param("id");
  const now = Date.now();
  const gone = await db
    .prepare("SELECT client_id FROM requests WHERE firm_id = ? AND id = ? AND deleted_at > ?")
    .bind(firmId, id, now - RESTORE_WINDOW)
    .first<{ client_id: string }>();
  if (!gone) return notFound(c);
  const alive = await db.prepare("SELECT 1 FROM clients WHERE firm_id = ? AND id = ? AND deleted_at IS NULL").bind(firmId, gone.client_id).first();
  if (!alive) return c.json({ error: "client_deleted" }, 409);
  const open = "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND deleted_at > ? AND purging_at IS NULL)";
  // a request the retention period took starts a fresh clock, so the next run does not take it again
  const start = "CASE WHEN deleted_reason = 'retention' THEN ?1 ELSE COALESCE(ended_at, ?1) END";
  const [, res] = await db.batch([
    audit(c, "request.restore", "request", id, undefined, { sql: open, binds: [firmId, id, now - RESTORE_WINDOW] }),
    db
      .prepare(
        `UPDATE requests SET deleted_at = NULL, deleted_reason = NULL, status = 'closed', closed_at = COALESCE(closed_at, ?1), next_reminder_at = NULL,
           ended_at = ${start},
           keep_until = ${start} + COALESCE((SELECT retention_years FROM firm_settings WHERE firm_id = requests.firm_id), ${DEFAULT_YEARS}) * ${YEAR}
         WHERE firm_id = ?2 AND id = ?3 AND deleted_at > ?4 AND purging_at IS NULL`,
      )
      .bind(now, firmId, id, now - RESTORE_WINDOW),
  ]);
  if (res.meta.changes) return c.json({ ok: true });
  const busy = await db.prepare("SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND purging_at IS NOT NULL").bind(firmId, id).first();
  return busy ? c.json({ error: "purging" }, 409) : notFound(c);
});

trash.post("/clients/:id/restore", async (c) => {
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const id = c.req.param("id");
  const since = Date.now() - RESTORE_WINDOW;
  const open = "deleted_at > ? AND NOT EXISTS (SELECT 1 FROM requests WHERE firm_id = clients.firm_id AND client_id = clients.id AND purging_at IS NOT NULL)";
  const [, res] = await db.batch([
    audit(c, "client.restore", "client", id, undefined, { sql: `EXISTS (SELECT 1 FROM clients WHERE firm_id = ? AND id = ? AND ${open})`, binds: [firmId, id, since] }),
    db.prepare(`UPDATE clients SET deleted_at = NULL WHERE firm_id = ? AND id = ? AND ${open}`).bind(firmId, id, since),
  ]);
  if (res.meta.changes) return c.json({ ok: true });
  const busy = await db.prepare("SELECT 1 FROM requests WHERE firm_id = ? AND client_id = ? AND purging_at IS NOT NULL").bind(firmId, id).first();
  return busy ? c.json({ error: "purging" }, 409) : notFound(c);
});
