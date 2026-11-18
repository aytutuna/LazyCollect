import { Hono } from "hono";
import { audit } from "./audit";
import { decryptStream, fileKey } from "./crypt";
import { firmDek } from "./keys";
import { regionOf, type Region } from "./regions";
import type { AppEnv } from "./session";
import { notFound } from "./validate";

export const files = new Hono<AppEnv>();

// RFC 6266: an ASCII fallback plus the UTF-8 form that modern browsers prefer
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\%]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// Hono answers HEAD from the GET handler, which would decrypt and audit a view
files.use("/files/:id", async (c, next) => (c.req.raw.method === "HEAD" ? c.body(null, 405, { Allow: "GET" }) : next()));

files.get("/files/:id", async (c) => {
  const firm = c.get("firm");
  const file = await c.get("db")
    .prepare(
      `SELECT f.id, f.request_id, f.r2_key, f.name, f.mime, f.size FROM files f
       JOIN requests r ON r.firm_id = f.firm_id AND r.id = f.request_id AND r.deleted_at IS NULL
       WHERE f.firm_id = ? AND f.id = ? AND f.state = 'live' AND f.deleted_at IS NULL`,
    )
    .bind(firm.id, c.req.param("id"))
    .first<{ id: string; request_id: string; r2_key: string; name: string; mime: string; size: number }>();
  if (!file) return notFound(c);
  const region = firm.region as Region;
  const object = await regionOf(c.env, region).bucket.get(file.r2_key);
  if (!object) return notFound(c);
  const key = await fileKey(await firmDek(c.env, region, firm.id, false), file.id);
  const plain = await decryptStream(key, object.body);
  await audit(c, "file.view", "file", file.id, { request: file.request_id }).run();
  return new Response(plain.pipeThrough(new FixedLengthStream(file.size)), {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": disposition(file.name),
      "Content-Length": String(file.size),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});
