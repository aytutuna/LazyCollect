import { DAY, hmac, randomId, randomToken } from "./util";

const encoder = new TextEncoder();

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Reminder emails have to carry the same link again, so the token is kept sealed next to its hash.
async function key(env: Env): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(`link-token:${env.HASH_KEY}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealToken(env: Env, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), encoder.encode(token));
  return b64(new Uint8Array([...iv, ...new Uint8Array(sealed)]));
}

export async function openToken(env: Env, sealed: string): Promise<string> {
  const bytes = unb64(sealed);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, await key(env), bytes.subarray(12));
  return new TextDecoder().decode(plain);
}

export const LINK_GRACE = 30 * DAY;

// a link made on the account's behalf by the reminder pass, when no live link can be opened again
export async function mintLink(env: Env, db: D1Database, region: string, firmId: string, requestId: string, deadline: number, now: number): Promise<string> {
  const token = `${region}_${randomToken()}`;
  const results = await db.batch([
    db.prepare("UPDATE links SET revoked_at = ? WHERE firm_id = ? AND request_id = ? AND revoked_at IS NULL").bind(now, firmId, requestId),
    db
      .prepare(
        `INSERT INTO links (token_hash, firm_id, request_id, expires_at, created_by, created_at, token_enc)
         SELECT ?, ?, ?, ?, 'system', ?, ? WHERE EXISTS (SELECT 1 FROM requests WHERE firm_id = ? AND id = ? AND status IN ('open', 'complete') AND deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM firm_settings WHERE firm_id = ? AND closed_at IS NOT NULL)`,
      )
      .bind(await hmac(env.HASH_KEY, token.slice(region.length + 1)), firmId, requestId, Math.max(deadline, now) + LINK_GRACE, now, await sealToken(env, token), firmId, requestId, firmId),
    db
      .prepare("INSERT INTO audit (id, firm_id, at, actor_type, action, object_type, object_id) VALUES (?, ?, ?, 'system', 'link.create', 'request', ?)")
      .bind(randomId(), firmId, now, requestId),
  ]);
  // a refused link must not go out in an email
  if (!results[1].meta.changes) throw new Error("link refused");
  return token;
}

// the live link as a url, from its sealed token
export async function linkUrl(env: Env, db: D1Database, region: string, firmId: string, requestId: string, deadline: number, now: number): Promise<string> {
  const row = await db
    .prepare(
      `SELECT token_enc FROM links WHERE firm_id = ? AND request_id = ? AND revoked_at IS NULL AND expires_at > ? AND token_enc IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(firmId, requestId, now)
    .first<{ token_enc: string }>();
  const token = row ? await openToken(env, row.token_enc) : await mintLink(env, db, region, firmId, requestId, deadline, now);
  return `${env.APP_URL}/c/${token}`;
}
