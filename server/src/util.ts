const encoder = new TextEncoder();

export const MINUTE = 60_000;
export const FETCH_TIMEOUT_MS = 10_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
// how long a deleted request or client can be restored before the cron removes it
export const RESTORE_WINDOW = 30 * DAY;

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

export async function sha256(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(s)));
}

export async function hmac(key: string, s: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, encoder.encode(s)));
}

// IPv6 clients hold whole /64s, so those share one rate limit bucket
export function ipPrefix(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":");
}

export async function keyLimited(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) throw new Error("rate limit binding is missing");
  const { success } = await limiter.limit({ key });
  return !success;
}

// A firm that holds a subscription, bought on the web or in the iPhone app; the one place that decides "paying" in SQL.
export const PAYING = "(stripe_subscription_id IS NOT NULL OR apple_original_transaction_id IS NOT NULL)";
