import { Hono, type Context } from "hono";
import { audit } from "./audit";
import { decryptStream, fileKey } from "./crypt";
import { firmDek } from "./keys";
import { regionOf, type Region } from "./regions";
import type { AppEnv } from "./session";
import { keyLimited } from "./util";
import { notFound } from "./validate";

export const files = new Hono<AppEnv>();

// RFC 6266: an ASCII fallback plus the UTF-8 form that modern browsers prefer
export function disposition(name: string, inline = false): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\%]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// Hono answers HEAD from the GET handler, which would decrypt and audit a view
files.use("/files/*", async (c, next) => (c.req.raw.method === "HEAD" ? c.body(null, 405, { Allow: "GET" }) : next()));

// the types a browser shows safely; the upload allowlist has already checked the bytes against the stored type
const INLINE = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

// Chrome and Safari refuse to open a PDF under the sandbox directive, so a PDF gets the rest of the lockdown without it
const VIEW_CSP: Record<string, string> = {
  pdf: "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'self'",
  image: "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'self'",
};

async function serve(c: Context<AppEnv>, inline: boolean) {
  const firm = c.get("firm");
  if (await keyLimited(c.env.FILE_VIEW, firm.id)) return c.json({ error: "rate_limited" }, 429);
  const file = await c.get("db")
    .prepare(
      `SELECT f.id, f.request_id, f.r2_key, f.name, f.mime, f.size FROM files f
       JOIN requests r ON r.firm_id = f.firm_id AND r.id = f.request_id AND r.deleted_at IS NULL
       WHERE f.firm_id = ? AND f.id = ? AND f.state = 'live' AND f.deleted_at IS NULL`,
    )
    .bind(firm.id, c.req.param("id"))
    .first<{ id: string; request_id: string; r2_key: string; name: string; mime: string; size: number }>();
  if (!file) return notFound(c);
  if (inline && !INLINE.includes(file.mime)) return c.json({ error: "not_viewable" }, 415);
  const region = firm.region as Region;
  const object = await regionOf(c.env, region).bucket.get(file.r2_key);
  if (!object) return notFound(c);
  const key = await fileKey(await firmDek(c.env, region, firm.id, false), file.id);
  const plain = await decryptStream(key, object.body);
  await audit(c, "file.view", "file", file.id, { request: file.request_id }).run();
  return new Response(plain.pipeThrough(new FixedLengthStream(file.size)), {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": disposition(file.name, inline),
      "Content-Length": String(file.size),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ...(inline && { "Content-Security-Policy": VIEW_CSP[file.mime === "application/pdf" ? "pdf" : "image"] }),
    },
  });
}

files.get("/files/:id", (c) => serve(c, false));
files.get("/files/:id/view", (c) => serve(c, true));
