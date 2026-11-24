import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { MINUTE, randomId } from "./util";
import { androidCerts, androidOrigin } from "./wellknown";

const CHALLENGE_TTL = 5 * MINUTE;
export const MAX_PASSKEYS = 10;
const ES256 = -7;
const RS256 = -257;

export type Passkey = {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  name: string;
  user_verified: number;
  created_at: number;
  last_used_at: number | null;
};

export type Who = { id: string; email: string; name: string | null };

function rp(env: Env) {
  const url = new URL(env.APP_URL);
  return { expectedRPID: url.hostname, expectedOrigin: [url.origin, ...androidCerts(env).map(androidOrigin)] };
}

const transportsOf = (p: Pick<Passkey, "transports">): string[] | undefined => (p.transports ? JSON.parse(p.transports) : undefined);

function remember(env: Env, userId: string, kind: "register" | "authenticate", challenge: string) {
  return env.CONTROL.prepare("INSERT INTO passkey_challenges (challenge, user_id, kind, expires_at) VALUES (?, ?, ?, ?)")
    .bind(challenge, userId, kind, Date.now() + CHALLENGE_TTL)
    .run();
}

// The library reads the challenge out of the browser's answer and asks here whether to accept it. Deleting the row is
// the check, so a challenge works once, only for the user and step it was made for, and only for 5 minutes.
function takes(env: Env, userId: string, kind: "register" | "authenticate") {
  return async (challenge: string) => {
    const row = await env.CONTROL.prepare("DELETE FROM passkey_challenges WHERE challenge = ? AND user_id = ? AND kind = ? AND expires_at > ? RETURNING 1 AS ok")
      .bind(challenge, userId, kind, Date.now())
      .first();
    return row !== null;
  };
}

export async function registrationOptions(env: Env, user: Who, have: Passkey[]) {
  const options = await generateRegistrationOptions({
    rpName: "Lazy Collect",
    rpID: rp(env).expectedRPID,
    userName: user.email,
    userDisplayName: user.name ?? user.email,
    userID: new Uint8Array(new TextEncoder().encode(user.id)),
    excludeCredentials: have.map((p) => ({ id: p.credential_id, transports: transportsOf(p) })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    supportedAlgorithmIDs: [ES256, RS256],
  });
  await remember(env, user.id, "register", options.challenge);
  return options;
}

export type NewPasskey = { credential_id: string; public_key: string; counter: number; transports: string | null; user_verified: number };

export async function verifyRegistration(env: Env, userId: string, response: RegistrationResponseJSON): Promise<NewPasskey | null> {
  try {
    const v = await verifyRegistrationResponse({ response, expectedChallenge: takes(env, userId, "register"), ...rp(env), requireUserVerification: false });
    if (!v.verified) return null;
    const { credential } = v.registrationInfo;
    return {
      credential_id: credential.id,
      public_key: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      user_verified: v.registrationInfo.userVerified ? 1 : 0,
    };
  } catch {
    return null;
  }
}

// the new row id, or null when the credential is already registered or the user is at the limit
export async function savePasskey(env: Env, userId: string, name: string, p: NewPasskey): Promise<string | null> {
  const id = randomId();
  const res = await env.CONTROL.prepare(
    `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, name, user_verified, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM passkeys WHERE user_id = ?) < ${MAX_PASSKEYS}
     ON CONFLICT DO NOTHING`,
  )
    .bind(id, userId, p.credential_id, p.public_key, p.counter, p.transports, name, p.user_verified, Date.now(), userId)
    .run();
  return res.meta.changes === 1 ? id : null;
}

export async function authenticationOptions(env: Env, userId: string, have: Passkey[]) {
  const options = await generateAuthenticationOptions({
    rpID: rp(env).expectedRPID,
    allowCredentials: have.map((p) => ({ id: p.credential_id, transports: transportsOf(p) })),
    userVerification: "preferred",
  });
  await remember(env, userId, "authenticate", options.challenge);
  return options;
}

export type Assertion = { ok: true; passkey: Passkey } | { ok: false; reason: "invalid" | "counter"; passkey?: Passkey };

export async function verifyAssertion(env: Env, userId: string, response: AuthenticationResponseJSON): Promise<Assertion> {
  const passkey = await env.CONTROL.prepare("SELECT * FROM passkeys WHERE credential_id = ? AND user_id = ?").bind(response.id, userId).first<Passkey>();
  if (!passkey) return { ok: false, reason: "invalid" };
  let counter: number;
  let verified: boolean;
  let uv: boolean;
  try {
    // The stored counter is not handed over: the library only reports "too low" as an error, and a counter that went
    // backwards has to be told apart from a bad signature so it can be logged.
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: takes(env, userId, "authenticate"),
      ...rp(env),
      requireUserVerification: false,
      credential: { id: passkey.credential_id, publicKey: isoBase64URL.toBuffer(passkey.public_key), counter: 0, transports: transportsOf(passkey) },
    });
    verified = v.verified;
    counter = v.authenticationInfo.newCounter;
    uv = v.authenticationInfo.userVerified;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!verified) return { ok: false, reason: "invalid" };
  // authenticators that do not count report 0 every time
  if ((counter > 0 || passkey.counter > 0) && counter <= passkey.counter) return { ok: false, reason: "counter", passkey };
  const res = await env.CONTROL.prepare("UPDATE passkeys SET counter = ?, last_used_at = ?, user_verified = ? WHERE id = ? AND counter = ?")
    .bind(counter, Date.now(), uv ? 1 : 0, passkey.id, passkey.counter)
    .run();
  return res.meta.changes === 1 ? { ok: true, passkey } : { ok: false, reason: "invalid" };
}
