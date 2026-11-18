const encoder = new TextEncoder();

export const MINUTE = 60_000;
export const FETCH_TIMEOUT_MS = 10_000;
export const DAY = 24 * 60 * MINUTE;

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
