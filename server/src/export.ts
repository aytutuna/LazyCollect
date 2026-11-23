import { Hono } from "hono";
import { audit } from "./audit";
import { keyLimited } from "./util";
import { fileKey, decryptStream } from "./crypt";
import { disposition } from "./files";
import { firmDek } from "./keys";
import { visible } from "./questions";
import { sentBackText } from "./reasons";
import { regionOf, type Region } from "./regions";
import { findRequest } from "./requests";
import type { AppEnv } from "./session";
import { notFound } from "./validate";
import { END_RECORD, cleanName, entryOverhead, uniqueName, zipStream, type ZipEntry } from "./zip";

export const exportZip = new Hono<AppEnv>();

// what the client said about items they could not send, what the account answered, and what was sent back and why; null when no item has such a story
async function checklistText(db: D1Database, firmId: string, requestId: string): Promise<string | null> {
  const { results } = await db
    .prepare(
      `SELECT label, status, reject_note, reject_reasons, unavailable_note, unavailable_at FROM items WHERE firm_id = ? AND request_id = ?
       AND (status IN ('unavailable', 'waived') OR unavailable_at IS NOT NULL OR (status = 'rejected' AND reject_reasons IS NOT NULL)) ORDER BY position`,
    )
    .bind(firmId, requestId)
    .all<{ label: string; status: string; reject_note: string | null; reject_reasons: string | null; unavailable_note: string | null; unavailable_at: number | null }>();
  if (!results.length) return null;
  const state = (i: (typeof results)[number]) =>
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
  const said = (i: (typeof results)[number]) =>
    i.unavailable_at === null && i.status !== "waived" ? "" : `  ${i.unavailable_note ? `client's reason: ${i.unavailable_note}` : "no reason given"}\n`;
  return results.map((i) => `${i.label}\n  ${state(i)}\n${said(i)}`).join("\n");
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
      `SELECT f.id, f.item_id, f.r2_key, f.name, f.size, f.uploaded_at, i.label FROM files f
       JOIN items i ON i.firm_id = f.firm_id AND i.request_id = f.request_id AND i.id = f.item_id
       WHERE f.firm_id = ? AND f.request_id = ? AND f.state = 'live' AND f.deleted_at IS NULL
       ORDER BY i.position, f.uploaded_at, f.rowid`,
    )
    .bind(firm.id, req.id)
    .all<{ id: string; item_id: string; r2_key: string; name: string; size: number; uploaded_at: number; label: string }>();
  const thread = await messagesText(c.get("db"), firm.id, req.id);
  const checklist = await checklistText(c.get("db"), firm.id, req.id);
  const given = await answersText(c.get("db"), firm.id, req.id);
  if (!results.length && !thread && !checklist && !given) return c.json({ error: "no_files" }, 409);
  if (results.length > MAX_ENTRIES) return c.json({ error: "export_too_big" }, 413);

  const region = firm.region as Region;
  const { bucket } = regionOf(c.env, region);
  const folders = new Map<string, { dir: string; n: number }>();
  const taken = new Set<string>();
  // an account that never received a file has no key yet
  const dek = results.length ? await firmDek(c.env, region, firm.id, false) : null!;
  const entries: ZipEntry[] = results.map((f) => {
    let folder = folders.get(f.item_id);
    if (!folder) folders.set(f.item_id, (folder = { dir: uniqueName(cleanName(f.label, 80, "item"), taken), n: 0 }));
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
