import { FETCH_TIMEOUT_MS, MINUTE } from "./util";

export const ANDROID_PACKAGE = "com.lazycollect.lazycollect";

type ServiceAccount = { client_email: string; private_key: string; token_uri: string };

const b64url = (b: ArrayBuffer | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...new Uint8Array(b))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

let cached: { token: string; until: number } | null = null;

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/playintegrity", aud: sa.token_uri, iat: now, exp: now + 3600 };
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const pem = sa.private_key.replace(/-----[A-Z ]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(signature)}` }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google token request failed with ${res.status}`);
  const body = await res.json<{ access_token: string; expires_in: number }>();
  cached = { token: body.access_token, until: Date.now() + (body.expires_in - 300) * 1000 };
  return body.access_token;
}

type Payload = {
  requestDetails?: { requestPackageName?: string; requestHash?: string; timestampMillis?: string };
  appIntegrity?: { appRecognitionVerdict?: string; packageName?: string };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
};

// Google decodes the token; this only accepts the verdict when it is for our app, for this request, and recent.
export async function playIntegrityOk(env: Env, token: string, requestHash: string): Promise<boolean> {
  const sa = JSON.parse(env.PLAY_INTEGRITY_SA!) as ServiceAccount;
  const res = await fetch(`${env.PLAY_INTEGRITY_BASE ?? "https://playintegrity.googleapis.com"}/v1/${ANDROID_PACKAGE}:decodeIntegrityToken`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken(sa)}`, "content-type": "application/json" },
    body: JSON.stringify({ integrity_token: token }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return false;
  const p = (await res.json<{ tokenPayloadExternal?: Payload }>()).tokenPayloadExternal;
  const sent = Number(p?.requestDetails?.timestampMillis);
  return (
    p?.requestDetails?.requestPackageName === ANDROID_PACKAGE &&
    p.requestDetails.requestHash === requestHash &&
    Math.abs(Date.now() - sent) < 10 * MINUTE &&
    p.appIntegrity?.packageName === ANDROID_PACKAGE &&
    p.appIntegrity.appRecognitionVerdict === "PLAY_RECOGNIZED" &&
    p.deviceIntegrity?.deviceRecognitionVerdict?.includes("MEETS_DEVICE_INTEGRITY") === true
  );
}
