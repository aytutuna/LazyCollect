import "reflect-metadata";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { X509Certificate, X509ChainBuilder } from "@peculiar/x509";

export const APP_ID = "8XT2U634Z4.com.lazycollect.lazycollect";

// https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
export const APPLE_ROOT = `
-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----
`;

const NONCE_OID = "1.2.840.113635.100.8.2";
const AAGUID = { production: "appattest\0\0\0\0\0\0\0", development: "appattestdevelop" };

const encoder = new TextEncoder();
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const cat = (a: Uint8Array, b: Uint8Array) => Uint8Array.from([...a, ...b]);

export type Key = { publicKey: string; env: "production" | "development" };

// Apple's steps for checking an attestation, in their order. The aaguid says which App Attest environment made it.
export async function verifyAttestation(env: Env, keyId: string, attestation: string, clientDataHash: Uint8Array): Promise<Key | null> {
  try {
    const obj = isoCBOR.decodeFirst(unb64(attestation)) as Map<string, any>;
    const stmt = obj.get("attStmt") as Map<string, Uint8Array[]>;
    const authData = obj.get("authData") as Uint8Array;
    const x5c = stmt.get("x5c");
    if (obj.get("fmt") !== "apple-appattest" || x5c?.length !== 2) return null;
    const [leaf, intermediate] = x5c.map((der) => new X509Certificate(der));
    const root = new X509Certificate(env.APP_ATTEST_ROOT ?? APPLE_ROOT);
    const chain = await new X509ChainBuilder({ certificates: [intermediate, root] }).build(leaf);
    if (chain.length !== 3 || !chain[2].equal(root)) return null;

    const nonce = await sha256(cat(authData, clientDataHash));
    // the extension is SEQUENCE { [1] { OCTET STRING nonce } }
    const ext = new Uint8Array(leaf.getExtension(NONCE_OID)?.value ?? []);
    if (ext.length !== 38 || !same(ext.subarray(0, 6), Uint8Array.of(0x30, 0x24, 0xa1, 0x22, 0x04, 0x20)) || !same(ext.subarray(6), nonce)) return null;

    const spki = await crypto.subtle.importKey("spki", leaf.publicKey.rawData, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    const point = new Uint8Array((await crypto.subtle.exportKey("raw", spki)) as ArrayBuffer);
    const hash = await sha256(point);
    if (!same(hash, unb64(keyId))) return null;

    const rpIdHash = authData.subarray(0, 32);
    const counter = new DataView(authData.buffer, authData.byteOffset).getUint32(33);
    const aaguid = new TextDecoder().decode(authData.subarray(37, 53));
    const idLength = (authData[53] << 8) | authData[54];
    const environment = aaguid === AAGUID.production ? "production" : aaguid === AAGUID.development ? "development" : null;
    if (!same(rpIdHash, await sha256(encoder.encode(APP_ID))) || counter !== 0 || !environment || !same(authData.subarray(55, 55 + idLength), hash)) return null;
    if (env.APP_ATTEST_ENV !== "any" && env.APP_ATTEST_ENV !== environment) return null;
    return { publicKey: btoa(String.fromCharCode(...point)), env: environment };
  } catch {
    return null;
  }
}

// ECDSA signatures arrive as DER, WebCrypto wants r and s side by side
function rawSignature(der: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  let at = 2;
  for (let half = 0; half < 2; half++) {
    if (der[at] !== 2) throw new Error("bad signature");
    const length = der[at + 1];
    let int = der.subarray(at + 2, at + 2 + length);
    at += 2 + length;
    while (int.length > 32 && int[0] === 0) int = int.subarray(1);
    out.set(int, half * 32 + 32 - int.length);
  }
  return out;
}

// the key's counter has to go up with every assertion, so a copied one is caught
export async function verifyAssertion(env: Env, keyId: string, assertion: string, clientDataHash: Uint8Array): Promise<boolean> {
  try {
    const row = await env.CONTROL.prepare("SELECT public_key, counter, env FROM app_keys WHERE key_id = ?").bind(keyId).first<{ public_key: string; counter: number; env: string }>();
    if (!row || (env.APP_ATTEST_ENV !== "any" && env.APP_ATTEST_ENV !== row.env)) return false;
    const obj = isoCBOR.decodeFirst(unb64(assertion)) as Map<string, Uint8Array>;
    const authData = obj.get("authenticatorData")!;
    const counter = new DataView(authData.buffer, authData.byteOffset).getUint32(33);
    if (!same(authData.subarray(0, 32), await sha256(encoder.encode(APP_ID))) || counter <= row.counter) return false;
    const key = await crypto.subtle.importKey("raw", unb64(row.public_key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const nonce = await sha256(cat(authData, clientDataHash));
    if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, rawSignature(obj.get("signature")!), nonce))) return false;
    const res = await env.CONTROL.prepare("UPDATE app_keys SET counter = ? WHERE key_id = ? AND counter = ?").bind(counter, keyId, row.counter).run();
    return res.meta.changes === 1;
  } catch {
    return false;
  }
}

// false when the key is already known: Apple attests a key once
export async function saveKey(env: Env, keyId: string, key: Key): Promise<boolean> {
  const res = await env.CONTROL.prepare("INSERT INTO app_keys (key_id, public_key, counter, env, created_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT DO NOTHING")
    .bind(keyId, key.publicKey, key.env, Date.now())
    .run();
  return res.meta.changes === 1;
}
