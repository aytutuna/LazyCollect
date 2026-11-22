import { Hono } from "hono";
import { audit } from "./audit";
import { isOwner } from "./firm";
import { findRequest } from "./requests";
import type { AppEnv } from "./session";
import { DEFAULT_YEARS, YEAR } from "./status";
import { invalid, notFound, readBody } from "./validate";

export const retention = new Hono<AppEnv>();

retention.get("/retention", async (c) => {
  const row = await c.get("db")
    .prepare("SELECT retention_years FROM firm_settings WHERE firm_id = ?")
    .bind(c.get("firm").id)
    .first<{ retention_years: number }>();
  return c.json({ years: row?.retention_years ?? DEFAULT_YEARS });
});

retention.put("/retention", async (c) => {
  if (!(await isOwner(c))) return c.json({ error: "forbidden" }, 403);
  const body = await readBody(c);
  const years = body?.years;
  if (typeof years !== "number" || !Number.isInteger(years) || years < 1 || years > 10) return invalid(c);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  await db.batch([
    db
      .prepare("INSERT INTO firm_settings (firm_id, retention_years) VALUES (?, ?) ON CONFLICT (firm_id) DO UPDATE SET retention_years = excluded.retention_years")
      .bind(firmId, years),
    db.prepare("UPDATE requests SET keep_until = ended_at + ? WHERE firm_id = ? AND ended_at IS NOT NULL").bind(years * YEAR, firmId),
    audit(c, "retention.update", "firm", firmId, { years }),
  ]);
  return c.json({ years });
});

retention.put("/requests/:id/hold", async (c) => {
  const body = await readBody(c);
  if (typeof body?.on !== "boolean") return invalid(c);
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE requests SET hold_at = ? WHERE firm_id = ? AND id = ? AND deleted_at IS NULL").bind(body.on ? now : null, firmId, req.id),
    audit(c, body.on ? "request.hold" : "request.release", "request", req.id),
  ]);
  return c.json({ hold_at: body.on ? now : null });
});
