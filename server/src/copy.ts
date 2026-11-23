import type { Row } from "./expand";

// what a copied item starts over with: no upload, review or answer carries across, and a new document has its own dates
const RESET: Record<string, string> = {
  status: "'empty'",
  reject_note: "NULL",
  reject_reasons: "NULL",
  reviewed_by: "NULL",
  reviewed_at: "NULL",
  unavailable_note: "NULL",
  unavailable_at: "NULL",
  answer: "NULL",
  answer_at: "NULL",
  expires_on: "NULL",
  issued_on: "NULL",
};

const ROW_COLS = [
  "position", "label", "help", "required", "kind", "options_json", "show_if_pos", "show_if_value", "example",
  "person_pos", "label_base", "for_pos", "companion", "translation", "expiry_rule", "valid_months", "blueprint",
] satisfies (keyof Row)[];

// the rows of one expansion for each request id; `when` ties the insert to a state the rest of its batch checked
export function insertRows(db: D1Database, firmId: string, requestIds: string[], rows: Row[], when?: { sql: string; binds: unknown[] }) {
  return db
    .prepare(
      `INSERT INTO items (id, firm_id, request_id, ${ROW_COLS.join(", ")})
       SELECT lower(hex(randomblob(16))), ?, r.value, ${ROW_COLS.map((c) => `json_extract(t.value, '$.${c}')`).join(", ")}
       FROM json_each(?) r, json_each(?) t WHERE EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = r.value)${when ? ` AND ${when.sql}` : ""}`,
    )
    .bind(firmId, JSON.stringify(requestIds), JSON.stringify(rows), firmId, ...(when?.binds ?? []));
}

// the item columns as the table has them now, so a column added later is copied without being listed here
export async function itemColumns(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("PRAGMA table_info(items)").all<{ name: string }>();
  return results.map((c) => c.name).filter((n) => n !== "id" && n !== "firm_id" && n !== "request_id");
}

// each new request gets the items of its source request, reset; the items that belong to a person only come along with the people
export function itemsFromRequests(db: D1Database, firmId: string, columns: string[], pairs: { id: string; src: string }[], withPeople: boolean) {
  return db
    .prepare(
      `INSERT INTO items (id, firm_id, request_id, ${columns.join(", ")})
       SELECT lower(hex(randomblob(16))), s.firm_id, j.id, ${columns.map((c) => RESET[c] ?? `s.${c}`).join(", ")}
       FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.src') AS src FROM json_each(?)) j
       JOIN items s ON s.firm_id = ? AND s.request_id = j.src
       WHERE EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = j.id)${withPeople ? "" : " AND s.person_pos IS NULL"}`,
    )
    .bind(JSON.stringify(pairs), firmId, firmId);
}

export function peopleFromRequests(db: D1Database, firmId: string, pairs: { id: string; src: string }[], now: number) {
  return db
    .prepare(
      `INSERT INTO people (id, firm_id, request_id, position, role, name, dob, created_at)
       SELECT lower(hex(randomblob(16))), s.firm_id, j.id, s.position, s.role, s.name, s.dob, ?
       FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.src') AS src FROM json_each(?)) j
       JOIN people s ON s.firm_id = ? AND s.request_id = j.src
       WHERE EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = j.id)`,
    )
    .bind(now, JSON.stringify(pairs), firmId, firmId);
}

// a year in the title moves to the next one
export const nextYearTitle = (title: string) => title.replace(/(?<!\d)(20\d\d)(?!\d)/g, (y) => String(Number(y) + 1));
