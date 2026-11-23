import { FETCH_TIMEOUT_MS } from "./util";

// the version the code was written against; an account's default version is not used
const API_VERSION = "2025-10-29.clover";

export class StripeError extends Error {
  constructor(public status: number, public code?: string) {
    super(`stripe request failed: HTTP ${status}`);
  }
}

export type Param = string | number | boolean | null | undefined | Param[] | { [key: string]: Param };

function encode(value: Param, key: string, out: URLSearchParams) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) value.forEach((v, i) => encode(v, `${key}[${i}]`, out));
  else if (typeof value === "object") for (const [k, v] of Object.entries(value)) encode(v, key ? `${key}[${k}]` : k, out);
  else out.append(key, String(value));
}

export async function stripe<T>(env: Env, method: "GET" | "POST" | "DELETE", path: string, params?: Param, idempotencyKey?: string): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  const body = new URLSearchParams();
  if (params) encode(params, "", body);
  const query = method === "GET" && params ? `?${body}` : "";
  const headers: Record<string, string> = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "stripe-version": API_VERSION };
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers["idempotency-key"] = idempotencyKey ?? crypto.randomUUID();
  }
  let res: Response;
  try {
    res = await fetch(`${env.STRIPE_API_BASE ?? "https://api.stripe.com"}${path}${query}`, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`stripe request failed: ${e instanceof Error ? e.name : "error"}`);
  }
  if (!res.ok) throw new StripeError(res.status, (await res.json<{ error?: { code?: string } }>().catch(() => null))?.error?.code);
  return res.json<T>();
}
