import { firmDek } from "./keys";
import { openToken } from "./links";
import { regionIds, regionOf, type Region } from "./regions";
import { hmac, sha256 } from "./util";

// scripts/deploy.mjs sends this header; the check answers nobody else
export const keyCheckGate = (env: Env) => hmac(env.HASH_KEY, "key-check");

// a short hash of a key, enough to tell two keys apart and useless for finding one
export const fingerprint = async (key: string) => (await sha256(`fingerprint:${key}`)).slice(0, 16);

// "ok" when the key opens a value stored with it, "none" when nothing is stored yet, "fail" otherwise
export async function masterCheck(env: Env): Promise<"ok" | "none" | "fail"> {
  const row = await env.CONTROL.prepare("SELECT id, region FROM firms WHERE dek_wrapped IS NOT NULL ORDER BY created_at LIMIT 1").first<{ id: string; region: Region }>();
  if (!row) return "none";
  try {
    await firmDek(env, row.region, row.id, false);
    return "ok";
  } catch {
    return "fail";
  }
}

export async function linkCheck(env: Env): Promise<"ok" | "none" | "fail"> {
  for (const id of regionIds) {
    const row = await regionOf(env, id)
      .db.prepare("SELECT token_hash, token_enc FROM links WHERE token_enc IS NOT NULL ORDER BY created_at LIMIT 1")
      .first<{ token_hash: string; token_enc: string }>();
    if (!row) continue;
    try {
      const token = await openToken(env, row.token_enc);
      return (await hmac(env.HASH_KEY, token.slice(id.length + 1))) === row.token_hash ? "ok" : "fail";
    } catch {
      return "fail";
    }
  }
  return "none";
}
