import { Hono } from "hono";
import { audit } from "./audit";
import { keyLimited } from "./util";
import { fileKey, decryptStream } from "./crypt";
import { disposition } from "./files";
import { firmDek } from "./keys";
import { withoutPerson } from "./expand";
import { validTo, visible } from "./questions";
import { sentBackText } from "./reasons";
import { regionOf, type Region } from "./regions";
import { findRequest } from "./requests";
import type { AppEnv } from "./session";
import { notFound } from "./validate";
import { END_RECORD, cleanName, entryOverhead, uniqueName, zipStream, type ZipEntry } from "./zip";

export const exportZip = new Hono<AppEnv>();

type Told = {
  label: string;
  status: string;
  reject_note: string | null;
  reject_reasons: string | null;
  unavailable_note: string | null;
  unavailable_at: number | null;
  expiry_rule: string | null;
  expires_on: string | null;
  issued_on: string | null;
  valid_months: number | null;
  valid_to: string | null;
};

// the date of a document, as the account reads it
const datesText = (i: Told) =>
  i.expiry_rule === "expiry" && i.expires_on
    ? `expires ${i.expires_on}`
    : i.expiry_rule === "issue" && i.issued_on
      ? `issued ${i.issued_on}, good for ${i.valid_months} months, until ${i.valid_to}`
      : null;

// what the client said about items they could not send, what the account answered, what was sent back and why, and the dates of documents; null when no item has such a story
async function checklistText(db: D1Database, firmId: string, requestId: string): Promise<string | null> {
  const { results } = await db
    .prepare(
      `SELECT label, status, reject_note, reject_reasons, unavailable_note, unavailable_at, expiry_rule, expires_on, issued_on, valid_months, ${validTo("items")} AS valid_to
       FROM items WHERE firm_id = ? AND request_id = ?
       AND (status IN ('unavailable', 'waived') OR unavailable_at IS NOT NULL OR (status = 'rejected' AND reject_reasons IS NOT NULL)
         OR (expiry_rule IS NOT NULL AND (expires_on IS NOT NULL OR issued_on IS NOT NULL))) ORDER BY position`,
    )
    .bind(firmId, requestId)
    .all<Told>();
  if (!results.length) return null;
  const told = (i: Told) => i.status === "waived" || i.status === "unavailable" || i.unavailable_at !== null || (i.status === "rejected" && i.reject_reasons !== null);
  const state = (i: Told) =>
    i.status === "waived"
      ? "accepted as not needed"
      : i.status === "unavailable"
        ? "client says they do not have it, waiting for an answer"
        : i.reject_reasons
          ? `sent back: ${sentBackText(i.reject_reasons, i.reject_note)}`
          : i.reject_note
            ? `asked again: ${i.reject_note}`
            : "client has it after all";
  // an item only sent back has no word from the client to report
  const said = (i: Told) =>
    i.unavailable_at === null && i.status !== "waived" ? "" : `  ${i.unavailable_note ? `client's reason: ${i.unavailable_note}` : "no reason given"}\n`;
  const lines = (i: Told) => [told(i) ? `  ${state(i)}\n${said(i)}` : "", datesText(i) ? `  ${datesText(i)}\n` : ""].join("");
  return results.map((i) => `${i.label}\n${lines(i)}`).join("\n");
}

// the questions that apply to the client and what they answered, in checklist order; null when there are none
async function answersText(db: D1Database, firmId: string, requestId: string): Promise<string | null> {
  const { results } = await db
    .prepare(
      `SELECT label, kind, answer, status, reject_note, reject_reasons FROM items i WHERE firm_id = ? AND request_id = ? AND kind != 'file' AND ${visible("i")} ORDER BY position`,
    )
    .bind(firmId, requestId)
    .all<{ label: string; kind: string; answer: string | null; status: string; reject_note: string | null; reject_reasons: string | null }>();
  if (!results.length) return null;
  const shown = (i: { kind: string; answer: string | null }) =>
    i.answer === null ? "no answer" : i.kind === "multi" ? (JSON.parse(i.answer) as string[]).join(", ") : i.kind === "yesno" ? (i.answer === "yes" ? "Yes" : "No") : i.answer;
  return results
    .map((i) => `${i.label}\n  ${shown(i)}${i.status === "rejected" && (i.reject_note || i.reject_reasons) ? `\n  sent back: ${sentBackText(i.reject_reasons, i.reject_note)}` : ""}\n`)
    .join("\n");
}

// the thread with the client as plain text, oldest first; null when there is none
async function messagesText(db: D1Database, firmId: string, requestId: string): Promise<string | null> {
  const { results } = await db
    .prepare("SELECT author, body, created_at FROM notes WHERE firm_id = ? AND request_id = ? ORDER BY created_at, rowid")
    .bind(firmId, requestId)
    .all<{ author: string; body: string; created_at: number }>();
  if (!results.length) return null;
  return results
    .map((n) => `${new Date(n.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC, ${n.author === "client" ? "client" : "account"}\n${n.body}\n`)
    .join("\n");
}

// without zip64 an archive stops at 4 GiB and 65535 entries
const MAX_BYTES = 0xffff0000;
const MAX_ENTRIES = 60000;

// Hono answers HEAD from the GET handler, which would audit an export
exportZip.use("/requests/:id/export", async (c, next) => (c.req.raw.method === "HEAD" ? c.body(null, 405, { Allow: "GET" }) : next()));

exportZip.get("/requests/:id/export", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const firm = c.get("firm");
  if (await keyLimited(c.env.EXPORT, firm.id)) return c.json({ error: "rate_limited" }, 429);
  const { results } = await c.get("db")
    .prepare(
      `SELECT f.id, f.item_id, f.r2_key, f.name, f.size, f.uploaded_at, i.label, i.person_pos,
         (SELECT name FROM people WHERE firm_id = i.firm_id AND request_id = i.request_id AND position = i.person_pos) AS person
       FROM files f
       JOIN items i ON i.firm_id = f.firm_id AND i.request_id = f.request_id AND i.id = f.item_id
       WHERE f.firm_id = ? AND f.request_id = ? AND f.state = 'live' AND f.deleted_at IS NULL
       ORDER BY i.position, f.uploaded_at, f.rowid`,
    )
    .bind(firm.id, req.id)
    .all<{ id: string; item_id: string; r2_key: string; name: string; size: number; uploaded_at: number; label: string; person_pos: number | null; person: string | null }>();
  const thread = await messagesText(c.get("db"), firm.id, req.id);
  const checklist = await checklistText(c.get("db"), firm.id, req.id);
  const given = await answersText(c.get("db"), firm.id, req.id);
  if (!results.length && !thread && !checklist && !given) return c.json({ error: "no_files" }, 409);
  if (results.length > MAX_ENTRIES) return c.json({ error: "export_too_big" }, 413);

  const region = firm.region as Region;
  const { bucket } = regionOf(c.env, region);
  const folders = new Map<string, { dir: string; n: number }>();
  const taken = new Set<string>();
  // each person has a folder with their items in it, named without repeating theirs
  const persons = new Map<number, { dir: string; taken: Set<string> }>();
  // an account that never received a file has no key yet
  const dek = results.length ? await firmDek(c.env, region, firm.id, false) : null!;
  const entries: ZipEntry[] = results.map((f) => {
    let folder = folders.get(f.item_id);
    if (!folder) {
      let person = f.person_pos === null ? undefined : persons.get(f.person_pos);
      if (f.person_pos !== null && !person) persons.set(f.person_pos, (person = { dir: uniqueName(cleanName(f.person ?? "", 60, "person"), taken), taken: new Set() }));
      const dir = uniqueName(cleanName(withoutPerson(f.label, f.person), 80, "item"), person ? person.taken : taken);
      folders.set(f.item_id, (folder = { dir: person ? `${person.dir}/${dir}` : dir, n: 0 }));
    }
    const ext = /\.([A-Za-z0-9]{1,5})$/.exec(f.name)?.[1] ?? "bin";
    return {
      name: `${folder.dir}/${++folder.n}.${ext.toLowerCase()}`,
      mtime: f.uploaded_at,
      async open() {
        const object = await bucket.get(f.r2_key);
        if (!object) throw new Error("file object missing");
        return decryptStream(await fileKey(dek, f.id), object.body);
      },
    };
  });

  const encoder = new TextEncoder();
  const sizes = results.map((f) => f.size);
  for (const [name, content] of [["messages.txt", thread], ["checklist.txt", checklist], ["answers.txt", given]] as const) {
    if (!content) continue;
    const bytes = encoder.encode(content);
    entries.push({ name, mtime: Date.now(), open: async () => new Blob([bytes]).stream() });
    sizes.push(bytes.length);
  }
  const total = entries.reduce((sum, e, i) => sum + sizes[i] + entryOverhead(encoder.encode(e.name).length), END_RECORD);
  if (total > MAX_BYTES) return c.json({ error: "export_too_big" }, 413);
  // the page asks first so it can show a refusal instead of navigating to a JSON error
  if (c.req.query("check") === "1") return c.body(null, 204);

  await audit(c, "export", "request", req.id, { files: results.length }).run();
  return new Response(zipStream(entries), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": disposition(`${cleanName(req.title, 100, "request")}.zip`),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});
