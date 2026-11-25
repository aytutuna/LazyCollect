import { regionOf, type Region } from "./regions";

const encoder = new TextEncoder();

// the tag names the wrapping scheme and master key, so a rotation can tell old wraps from new ones
const WRAP_TAG = "gcm1:";

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function masterKey(env: Env, region: Region): Promise<CryptoKey> {
  const raw = unb64(regionOf(env, region).key ?? "");
  if (raw.length !== 32) throw new Error("master key must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function wrap(master: CryptoKey, dek: Uint8Array, firmId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(firmId) }, master, dek);
  return WRAP_TAG + b64(new Uint8Array([...iv, ...new Uint8Array(sealed)]));
}

async function unwrap(master: CryptoKey, wrapped: string, firmId: string): Promise<Uint8Array> {
  if (!wrapped.startsWith(WRAP_TAG)) throw new Error("unknown key wrapping");
  const bytes = unb64(wrapped.slice(WRAP_TAG.length));
  const dek = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: encoder.encode(firmId) },
    master,
    bytes.subarray(12),
  );
  return new Uint8Array(dek);
}

const read = (env: Env, firmId: string) =>
  env.CONTROL.prepare("SELECT dek_wrapped FROM firms WHERE id = ?").bind(firmId).first<{ dek_wrapped: string | null }>();

// the firm id is the AAD so a wrapped key copied onto another firm's row won't open
export async function firmDek(env: Env, region: Region, firmId: string, create: boolean): Promise<Uint8Array> {
  const master = await masterKey(env, region);
  let row = await read(env, firmId);
  if (!row) throw new Error("firm not found");
  if (!row.dek_wrapped && create) {
    const wrapped = await wrap(master, crypto.getRandomValues(new Uint8Array(32)), firmId);
    await env.CONTROL.prepare("UPDATE firms SET dek_wrapped = ? WHERE id = ? AND dek_wrapped IS NULL").bind(wrapped, firmId).run();
    row = await read(env, firmId);
  }
  if (!row?.dek_wrapped) throw new Error("firm has no key");
  return unwrap(master, row.dek_wrapped, firmId);
}

// a wrapped key kept beside a held file, for when the account's own row is gone
export async function openDek(env: Env, region: Region, wrapped: string, firmId: string): Promise<Uint8Array> {
  return unwrap(await masterKey(env, region), wrapped, firmId);
}
