// A software authenticator for tests: ES256 keys, "none" attestation, signed in the shapes a browser hands to the server.
const encoder = new TextEncoder();

export const ORIGIN = "https://collect.alazy.app";
const RP_ID = "collect.alazy.app";

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unb64 = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
export const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
export const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
}

export type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

export function cbor(v: Cbor): Uint8Array {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return cat(head(3, encoder.encode(v).length), encoder.encode(v));
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (Array.isArray(v)) return cat(head(4, v.length), ...v.map(cbor));
  return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

// WebCrypto signs as r||s; WebAuthn carries it as DER
export function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const body = b[i] & 0x80 ? cat(new Uint8Array([0]), b.subarray(i)) : b.subarray(i);
    return cat(new Uint8Array([2, body.length]), body);
  };
  const body = cat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return cat(new Uint8Array([0x30, body.length]), body);
}

async function sha256(b: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b));
}

type Options = { challenge: string };

export class Authenticator {
  counter = 0;
  readonly id = crypto.getRandomValues(new Uint8Array(32));

  private constructor(
    private pair: CryptoKeyPair,
    private x: Uint8Array,
    private y: Uint8Array,
    readonly verifies: boolean,
  ) {}

  static async create(verifies = true) {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    return new Authenticator(pair, unb64(jwk.x!), unb64(jwk.y!), verifies);
  }

  get credentialId() {
    return b64(this.id);
  }

  private clientData(type: string, challenge: string, origin: string) {
    return encoder.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  private flags(attested: boolean) {
    return 0x01 | (this.verifies ? 0x04 : 0) | (attested ? 0x40 : 0);
  }

  async register(options: Options, origin = ORIGIN) {
    const cose = new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]);
    const attested = cat(new Uint8Array(16), new Uint8Array([this.id.length >> 8, this.id.length & 255]), this.id, cbor(cose));
    const authData = cat(await sha256(encoder.encode(RP_ID)), new Uint8Array([this.flags(true)]), u32(this.counter), attested);
    const attestationObject = cbor(new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: { clientDataJSON: b64(this.clientData("webauthn.create", options.challenge, origin)), attestationObject: b64(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  // counter: what the authenticator reports; by default it goes up by one each time
  async assert(options: Options, opts: { origin?: string; counter?: number } = {}) {
    this.counter = opts.counter ?? this.counter + 1;
    const clientData = this.clientData("webauthn.get", options.challenge, opts.origin ?? ORIGIN);
    const authData = cat(await sha256(encoder.encode(RP_ID)), new Uint8Array([this.flags(false)]), u32(this.counter));
    const signed = cat(authData, await sha256(clientData));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.pair.privateKey, signed));
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(der(raw)) },
      clientExtensionResults: {},
    };
  }
}
