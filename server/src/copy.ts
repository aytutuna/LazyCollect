import type { Item } from "./templates";

// what a copied item starts over with: no upload, review or answer carries across
const RESET: Record<string, string> = {
  status: "'empty'",
  reject_note: "NULL",
  reviewed_by: "NULL",
  reviewed_at: "NULL",
  unavailable_note: "NULL",
  unavailable_at: "NULL",
};

// one copy of a template's items for each request id
export function itemsFromTemplate(db: D1Database, firmId: string, requestIds: string[], items: Item[]) {
  return db
    .prepare(
      `INSERT INTO items (id, firm_id, request_id, position, label, help, required)
       SELECT lower(hex(randomblob(16))), ?, r.value, t.key, json_extract(t.value, '$.label'), json_extract(t.value, '$.help'), json_extract(t.value, '$.required')
       FROM json_each(?) r, json_each(?) t WHERE EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = r.value)`,
    )
    .bind(firmId, JSON.stringify(requestIds), JSON.stringify(items), firmId);
}

// the item columns as the table has them now, so a column added later is copied without being listed here
export async function itemColumns(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("PRAGMA table_info(items)").all<{ name: string }>();
  return results.map((c) => c.name).filter((n) => n !== "id" && n !== "firm_id" && n !== "request_id");
}

// each new request gets the items of its source request, reset
export function itemsFromRequests(db: D1Database, firmId: string, columns: string[], pairs: { id: string; src: string }[]) {
  return db
    .prepare(
      `INSERT INTO items (id, firm_id, request_id, ${columns.join(", ")})
       SELECT lower(hex(randomblob(16))), s.firm_id, j.id, ${columns.map((c) => RESET[c] ?? `s.${c}`).join(", ")}
       FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.src') AS src FROM json_each(?)) j
       JOIN items s ON s.firm_id = ? AND s.request_id = j.src
       WHERE EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = j.id)`,
    )
    .bind(JSON.stringify(pairs), firmId, firmId);
}

// a year in the title moves to the next one
export const nextYearTitle = (title: string) => title.replace(/(?<!\d)(20\d\d)(?!\d)/g, (y) => String(Number(y) + 1));
