import type { Context } from "hono";

export const invalid = (c: Context) => c.json({ error: "invalid" }, 400);
export const notFound = (c: Context) => c.json({ error: "not_found" }, 404);

export async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export function text(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s.length <= max ? s : undefined;
}

export const blank = (v: unknown) => v === undefined || v === null || v === "";

// null when left blank, undefined when invalid
export function maybe(v: unknown, max: number): string | null | undefined {
  return blank(v) ? null : text(v, max);
}

const LOCALES = ["en", "fr-CA"];

export function locale(v: unknown): string | undefined {
  return typeof v === "string" && LOCALES.includes(v) ? v : undefined;
}

export function setClause(fields: Record<string, string | number | null>) {
  return { sql: Object.keys(fields).map((k) => `${k} = ?`).join(", "), values: Object.values(fields) };
}
