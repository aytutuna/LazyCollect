import { Hono } from "hono";
import { audit } from "./audit";
import { fileKey, decryptStream } from "./crypt";
import { disposition } from "./files";
import { firmDek } from "./keys";
import { regionOf, type Region } from "./regions";
import { findRequest } from "./requests";
import type { AppEnv } from "./session";
import { notFound } from "./validate";
import { END_RECORD, cleanName, entryOverhead, uniqueName, zipStream, type ZipEntry } from "./zip";

export const exportZip = new Hono<AppEnv>();

// without zip64 an archive stops at 4 GiB and 65535 entries
const MAX_BYTES = 0xffff0000;
const MAX_ENTRIES = 60000;

// Hono answers HEAD from the GET handler, which would audit an export
exportZip.use("/requests/:id/export", async (c, next) => (c.req.raw.method === "HEAD" ? c.body(null, 405, { Allow: "GET" }) : next()));

exportZip.get("/requests/:id/export", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const firm = c.get("firm");
  const { results } = await c.get("db")
    .prepare(
      `SELECT f.id, f.item_id, f.r2_key, f.name, f.size, f.uploaded_at, i.label FROM files f
       JOIN items i ON i.firm_id = f.firm_id AND i.request_id = f.request_id AND i.id = f.item_id
       WHERE f.firm_id = ? AND f.request_id = ? AND f.state = 'live' AND f.deleted_at IS NULL
       ORDER BY i.position, f.uploaded_at, f.rowid`,
    )
    .bind(firm.id, req.id)
    .all<{ id: string; item_id: string; r2_key: string; name: string; size: number; uploaded_at: number; label: string }>();
  if (!results.length) return c.json({ error: "no_files" }, 409);
  if (results.length > MAX_ENTRIES) return c.json({ error: "export_too_big" }, 413);

  const region = firm.region as Region;
  const { bucket } = regionOf(c.env, region);
  const folders = new Map<string, { dir: string; n: number }>();
  const taken = new Set<string>();
  const dek = await firmDek(c.env, region, firm.id, false);
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
  const total = entries.reduce((sum, e, i) => sum + results[i].size + entryOverhead(encoder.encode(e.name).length), END_RECORD);
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
