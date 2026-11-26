import { Hono } from "hono";
import { audit } from "./audit";
import { itemColumns, itemsFromRequests, nextYearTitle, peopleFromRequests } from "./copy";
import { SINGLE_TODAY, findRequest, loadRequest } from "./requests";
import type { AppEnv } from "./session";
import { plusYear } from "./tz";
import { yearOn } from "./yearon";
import { DAY, randomId } from "./util";
import { notFound } from "./validate";

export const repeat = new Hono<AppEnv>();

// a draft for the same client with the same checklist, a year on; whatever came in on the old one stays there
repeat.post("/requests/:id/repeat", async (c) => {
  const src = await findRequest(c);
  if (!src) return notFound(c);
  const db = c.get("db");
  const firm = c.get("firm");
  const row = await db.prepare("SELECT note FROM requests WHERE firm_id = ? AND id = ?").bind(firm.id, src.id).first<{ note: string | null }>();
  const alive = "EXISTS (SELECT 1 FROM clients WHERE firm_id = ? AND id = ? AND deleted_at IS NULL)";
  if (!(await db.prepare(`SELECT ${alive} AS ok`).bind(firm.id, src.client_id).first<{ ok: number }>())!.ok) return c.json({ error: "client_deleted" }, 409);
  const id = randomId();
  const now = Date.now();
  // the checklist moves to the next tax year, or the repeat waits until that year's dates are known
  const later = await yearOn(db, firm.id, [{ id, src: src.id }]);
  if (later === "unknown") return c.json({ error: "tax_year_unknown" }, 409);
  const [res] = await db.batch([
    db
      .prepare(
        `INSERT INTO requests (id, firm_id, client_id, title, note, deadline, reminders_on, created_by, created_at, per_person_json, valid_until, locale)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT per_person_json FROM requests WHERE firm_id = ? AND id = ?), (SELECT date(valid_until, '+1 year') FROM requests WHERE firm_id = ? AND id = ?), ?
         WHERE ${alive} AND ${SINGLE_TODAY}`,
      )
      .bind(id, firm.id, src.client_id, nextYearTitle(src.title).slice(0, 200), row!.note, plusYear(src.deadline, firm.tz), src.reminders_on, c.get("session")!.userId, now, firm.id, src.id, firm.id, src.id, src.locale, firm.id, src.client_id, firm.id, now - DAY, firm.id),
    peopleFromRequests(db, firm.id, [{ id, src: src.id }], now),
    itemsFromRequests(db, firm.id, await itemColumns(db), [{ id, src: src.id }], true),
    ...later.statements,
    audit(c, "request.repeat", "request", id, { from: src.id }, { sql: "EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ?)", binds: [firm.id, id] }),
  ]);
  if (!res.meta.changes) return c.json({ error: "too_many_requests" }, 429);
  return c.json({ ...(await loadRequest(c, id)), stale_years: later.stale }, 201);
});
