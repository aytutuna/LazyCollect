import type { Context } from "hono";
import { expiring, today } from "./expiry";
import { validTo, visible } from "./questions";
import type { AppEnv } from "./session";
import { DAY } from "./util";
import { invalid } from "./validate";

export const PAGE = 50;
const MAX_OFFSET = 100_000;
const MAX_QUERY = 100;

export const VIEWS = ["to_review", "waiting", "expiring", "overdue", "due_soon", "all", "done"] as const;
type View = (typeof VIEWS)[number];

const STATUSES = ["draft", "open", "complete", "expired", "closed"];

// the sort goes into the statement, so only these strings ever reach it
const SORTS = {
  newest: "created_at DESC, id DESC",
  deadline: "deadline, id",
  activity: "COALESCE(last_at, sent_at, created_at) DESC, id DESC",
} as const;
type Sort = keyof typeof SORTS;

// a search typed by a person is a literal: % and _ must not act as wildcards, and ! is the escape character
export const likeOf = (q: string) => `%${q.replace(/[!%_]/g, "!$&")}%`;

// 0 when absent, undefined when invalid
export function offsetOf(c: Context<AppEnv>): number | undefined {
  const v = c.req.query("offset");
  if (v === undefined) return 0;
  return /^\d{1,6}$/.test(v) && Number(v) <= MAX_OFFSET ? Number(v) : undefined;
}

export function queryOf(c: Context<AppEnv>): string | undefined {
  const q = (c.req.query("q") ?? "").trim();
  return q.length <= MAX_QUERY ? q : undefined;
}

// each view as a condition on the grouped rows below
const WHEN = (now: number): Record<Exclude<View, "all">, { sql: string; binds: number[] }> => ({
  to_review: { sql: "status IN ('open', 'complete') AND (submitted > 0 OR unavailable > 0 OR unanswered > 0)", binds: [] },
  waiting: { sql: "status = 'open' AND missing > 0", binds: [] },
  expiring: { sql: "status IN ('open', 'complete') AND expiring > 0", binds: [] },
  overdue: { sql: "status = 'open' AND deadline < ?", binds: [now] },
  due_soon: { sql: "status = 'open' AND deadline >= ? AND deadline < ?", binds: [now, now + 7 * DAY] },
  done: { sql: "status IN ('complete', 'closed')", binds: [] },
});

export async function listRequests(c: Context<AppEnv>) {
  const view = c.req.query("view") ?? "all";
  const sort = c.req.query("sort") ?? "newest";
  const status = c.req.query("status");
  const client = c.req.query("client");
  const q = queryOf(c);
  const offset = offsetOf(c);
  if (!(VIEWS as readonly string[]).includes(view) || !Object.hasOwn(SORTS, sort) || (status && !STATUSES.includes(status)) || (client && !/^[0-9a-f]{32}$/.test(client)) || q === undefined || offset === undefined) {
    return invalid(c);
  }
  const db = c.get("db");
  const firmId = c.get("firm").id;
  const now = Date.now();
  const like = likeOf(q);

  const conds = ["r.firm_id = ?", "r.deleted_at IS NULL"];
  const binds: unknown[] = [firmId];
  if (status) {
    conds.push("r.status = ?");
    binds.push(status);
  }
  if (client) {
    conds.push("r.client_id = ?");
    binds.push(client);
  }
  if (q) {
    conds.push("(cl.name LIKE ? ESCAPE '!' OR cl.email LIKE ? ESCAPE '!' OR r.title LIKE ? ESCAPE '!')");
    binds.push(like, like, like);
  }
  const dated = today(now, c.get("firm").tz);
  const flagged = expiring("i", "r", dated);
  const grouped = (withActivity: boolean) =>
    `SELECT r.id, r.client_id, cl.name AS client_name, r.title, r.deadline, r.status, r.sent_at, r.created_at,
       COALESCE(SUM(i.status = 'empty' AND ${visible("i")}), 0) AS empty,
       COALESCE(SUM(i.status = 'submitted' AND ${visible("i")}), 0) AS submitted,
       COALESCE(SUM(i.status = 'approved' AND ${visible("i")}), 0) AS approved,
       COALESCE(SUM(i.status = 'rejected' AND ${visible("i")}), 0) AS rejected,
       COALESCE(SUM(i.status = 'unavailable' AND ${visible("i")}), 0) AS unavailable,
       COALESCE(SUM(i.status = 'waived' AND ${visible("i")}), 0) AS waived,
       (SELECT COUNT(*) FROM notes n WHERE n.firm_id = r.firm_id AND n.request_id = r.id AND n.author = 'client'
         AND n.created_at > COALESCE((SELECT MAX(created_at) FROM notes WHERE firm_id = r.firm_id AND request_id = r.id AND author = 'user'), 0)) AS unanswered,
       COALESCE(SUM(${flagged}), 0) AS expiring,
       MIN(CASE WHEN ${flagged} THEN ${validTo("i")} END) AS expiring_on,
       COALESCE(SUM(i.required = 1 AND i.status IN ('empty', 'rejected') AND ${visible("i")}), 0) AS missing${
         withActivity
           ? `, NULLIF(MAX(COALESCE(MAX(i.reviewed_at), 0), COALESCE((SELECT MAX(f.uploaded_at) FROM files f WHERE f.firm_id = r.firm_id AND f.request_id = r.id AND f.state = 'live' AND f.deleted_at IS NULL), 0), COALESCE(MAX(i.unavailable_at), 0), COALESCE(MAX(i.answer_at), 0), COALESCE((SELECT MAX(n.created_at) FROM notes n WHERE n.firm_id = r.firm_id AND n.request_id = r.id), 0)), 0) AS last_at`
           : ""
       }
     FROM requests r
     JOIN clients cl ON cl.firm_id = r.firm_id AND cl.id = r.client_id AND cl.deleted_at IS NULL
     LEFT JOIN items i ON i.firm_id = r.firm_id AND i.request_id = r.id
     WHERE ${conds.join(" AND ")}
     GROUP BY r.id`;

  const when = WHEN(now);
  const pick = view === "all" ? null : when[view as keyof typeof when];
  const page = db
    .prepare(
      `SELECT * FROM (${grouped(sort === "activity")}) t${pick ? ` WHERE ${pick.sql}` : ""}
       ORDER BY ${SORTS[sort as Sort]} LIMIT ${PAGE + 1} OFFSET ${offset}`,
    )
    .bind(...binds, ...(pick?.binds ?? []));
  // the tabs show every view for the same search, so they are counted once from the first page's request
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS "all", ${(Object.keys(when) as (keyof typeof when)[])
        .map((k) => `COALESCE(SUM(${when[k].sql}), 0) AS ${k}`)
        .join(", ")} FROM (${grouped(false)}) t`,
    )
    // the view conditions come first in the statement's text, so their values come first
    .bind(...Object.values(when).flatMap((w) => w.binds), ...binds);
  const first = offset === 0;
  const who = client ? db.prepare("SELECT id, name FROM clients WHERE firm_id = ? AND id = ? AND deleted_at IS NULL").bind(firmId, client) : null;
  const [rows, ...rest] = await db.batch([page, ...(first ? [counts] : []), ...(who ? [who] : [])]);
  const list = rows.results as Record<string, unknown>[];
  return c.json({
    rows: list.slice(0, PAGE).map(({ missing: _m, last_at: _l, ...r }) => r),
    next: list.length > PAGE ? offset + PAGE : null,
    counts: first ? rest[0].results[0] : null,
    client: who ? (rest[first ? 1 : 0].results[0] ?? null) : null,
  });
}
