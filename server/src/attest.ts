import { saveKey, verifyAssertion, verifyAttestation } from "./appattest";
import { playIntegrityOk } from "./playintegrity";
import type { App } from "./session";
import { MINUTE, randomToken } from "./util";

const CHALLENGE_TTL = 5 * MINUTE;

export type Attestation = { challenge?: unknown; token?: unknown; key_id?: unknown; assertion?: unknown };

// whether the server checks this platform at all; the app skips asking its OS for a proof when it does not
export const checked = (env: Env, platform: App) => (platform === "android" ? Boolean(env.PLAY_INTEGRITY_SA) : Boolean(env.APP_ATTEST_ENV));

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

// Each platform's check stays off until its config is set, so the endpoints can ship before the Play Integrity service
// account exists or App Attest is switched on. Turnstile does not run in the apps; the rate limits are what is left then.
export async function attested(env: Env, platform: App, att: unknown, data: string): Promise<boolean> {
  if (!checked(env, platform)) return true;
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
