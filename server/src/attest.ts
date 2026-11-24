import { saveKey, verifyAssertion, verifyAttestation } from "./appattest";
import { playIntegrityOk } from "./playintegrity";
import type { App } from "./session";
import { MINUTE, randomToken } from "./util";

const CHALLENGE_TTL = 5 * MINUTE;

export type Attestation = { challenge?: unknown; token?: unknown; key_id?: unknown; assertion?: unknown };

// whether the server checks this platform; the app skips asking its OS for a proof when it does not
export const checked = (env: Env, platform: App) => !skipped(env, platform) && (platform === "android" ? Boolean(env.PLAY_INTEGRITY_SA) : Boolean(env.APP_ATTEST_ENV));

// APP_ATTEST_OFF exists so local development can run without Play Integrity or App Attest. It goes in .dev.vars only,
// never in wrangler.toml, and is ignored unless APP_URL is local, so a leaked secret can't switch the checks off on the
// live site. A platform with no check and not listed here is refused instead of waved through.
const local = (env: Env) => /^http:\/\/(localhost|127\.0\.0\.1)/.test(env.APP_URL);
const skipped = (env: Env, platform: App) => local(env) && (env.APP_ATTEST_OFF ?? "").split(",").some((p) => p.trim() === platform);

export const usable = (env: Env, platform: App) => skipped(env, platform) || checked(env, platform);

export async function issueChallenge(env: Env): Promise<string> {
  const challenge = randomToken();
  await env.CONTROL.prepare("INSERT INTO app_challenges (challenge, expires_at) VALUES (?, ?)").bind(challenge, Date.now() + CHALLENGE_TTL).run();
  return challenge;
}

// deleting the row is the check: a challenge works once and only for 5 minutes
async function takeChallenge(env: Env, challenge: string): Promise<boolean> {
  const row = await env.CONTROL.prepare("DELETE FROM app_challenges WHERE challenge = ? AND expires_at > ? RETURNING 1 AS ok").bind(challenge, Date.now()).first();
  return row !== null;
}

// What the device signs: its proof is tied to one challenge and to the data of the request it accompanies.
export async function bindingHash(challenge: string, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${challenge}.${data}`)));
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

// Turnstile does not run in the apps, so a platform without a working check is not usable at all (see usable).
export async function attested(env: Env, platform: App, att: unknown, data: string): Promise<boolean> {
  if (skipped(env, platform)) return true;
  if (!checked(env, platform)) return false;
  if (!att || typeof att !== "object") return false;
  const { challenge, token, key_id, assertion } = att as Attestation;
  if (typeof challenge !== "string" || !(await takeChallenge(env, challenge))) return false;
  if (platform === "android") return typeof token === "string" && playIntegrityOk(env, token, b64url(await bindingHash(challenge, data)));
  return typeof key_id === "string" && typeof assertion === "string" && verifyAssertion(env, key_id, assertion, await bindingHash(challenge, data));
}

// An iPhone attests its key once; the challenge is bound with the fixed data "attest".
export async function attestKey(env: Env, keyId: string, challenge: string, attestation: string): Promise<boolean> {
  if (!env.APP_ATTEST_ENV || !(await takeChallenge(env, challenge))) return false;
  const key = await verifyAttestation(env, keyId, attestation, await bindingHash(challenge, "attest"));
  return key !== null && saveKey(env, keyId, key);
}
