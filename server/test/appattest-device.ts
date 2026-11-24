// A stand-in for an iPhone's App Attest: a CA chain of its own and a key that attests and asserts the way Apple's does.
import "reflect-metadata";
import { BasicConstraintsExtension, Extension, X509CertificateGenerator } from "@peculiar/x509";
import { cat, cbor, der, u32 } from "./authenticator";

const ES256 = { name: "ECDSA", hash: "SHA-256" };
const encoder = new TextEncoder();
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const std = (b: Uint8Array) => btoa(String.fromCharCode(...b));

export const APP_ID = "8XT2U634Z4.com.lazycollect.lazycollect";
export const PRODUCTION = "appattest\0\0\0\0\0\0\0";
export const DEVELOPMENT = "appattestdevelop";

const newKeys = () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
const toPem = (der: ArrayBuffer) => `-----BEGIN CERTIFICATE-----\n${btoa(String.fromCharCode(...new Uint8Array(der))).match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----`;

export class Ca {
  private constructor(
    readonly rootPem: string,
    private intermediate: { cert: ArrayBuffer; keys: CryptoKeyPair },
  ) {}

  static async create() {
    const root = await newKeys();
    const rootCert = await X509CertificateGenerator.create({
      serialNumber: "01",
      subject: "CN=Test Attestation Root",
      issuer: "CN=Test Attestation Root",
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + 86_400_000 * 365),
      signingKey: root.privateKey,
      publicKey: root.publicKey,
      signingAlgorithm: ES256,
      extensions: [new BasicConstraintsExtension(true, undefined, true)],
    });
    const keys = await newKeys();
    const cert = await X509CertificateGenerator.create({
      serialNumber: "02",
      subject: "CN=Test Attestation CA 1",
      issuer: "CN=Test Attestation Root",
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + 86_400_000 * 365),
      signingKey: root.privateKey,
      publicKey: keys.publicKey,
      signingAlgorithm: ES256,
      extensions: [new BasicConstraintsExtension(true, undefined, true)],
    });
    return new Ca(toPem(rootCert.rawData), { cert: cert.rawData, keys });
  }

  async leaf(publicKey: CryptoKey, nonce: Uint8Array) {
    const cert = await X509CertificateGenerator.create({
      serialNumber: "03",
      subject: "CN=Device",
      issuer: "CN=Test Attestation CA 1",
      notBefore: new Date(Date.now() - 3_600_000),
      notAfter: new Date(Date.now() + 3_600_000),
      signingKey: this.intermediate.keys.privateKey,
      publicKey,
      signingAlgorithm: ES256,
      extensions: [new Extension("1.2.840.113635.100.8.2", false, cat(Uint8Array.of(0x30, 0x24, 0xa1, 0x22, 0x04, 0x20), nonce))],
    });
    return [new Uint8Array(cert.rawData), new Uint8Array(this.intermediate.cert)];
  }
}

type Attest = { aaguid?: string; appId?: string; counter?: number; keyId?: string; nonce?: Uint8Array };

export class Device {
  counter = 0;

  private constructor(
    private keys: CryptoKeyPair,
    private point: Uint8Array,
    readonly hash: Uint8Array,
  ) {}

  static async create() {
    const keys = await newKeys();
    const point = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
    return new Device(keys, point, await sha256(point));
  }

  get keyId() {
    return std(this.hash);
  }

  async attest(ca: Ca, clientDataHash: Uint8Array, o: Attest = {}) {
    const authData = cat(
      await sha256(encoder.encode(o.appId ?? APP_ID)),
      Uint8Array.of(0x40),
      u32(o.counter ?? 0),
      encoder.encode(o.aaguid ?? PRODUCTION),
      Uint8Array.of(this.hash.length >> 8, this.hash.length & 255),
      this.hash,
    );
    const nonce = o.nonce ?? (await sha256(cat(authData, clientDataHash)));
    const object = cbor(new Map<string, any>([["fmt", "apple-appattest"], ["attStmt", new Map<string, any>([["x5c", await ca.leaf(this.keys.publicKey, nonce)], ["receipt", new Uint8Array(8)]])], ["authData", authData]]));
    return std(object);
  }

  // counter: what the device reports; by default it goes up by one each time. singleHash signs authData||clientDataHash
  // as it is, which ES256 then hashes once instead of the twice Apple does
  async assert(clientDataHash: Uint8Array, o: { appId?: string; counter?: number; signer?: Device; singleHash?: boolean } = {}) {
    this.counter = o.counter ?? this.counter + 1;
    const authData = cat(await sha256(encoder.encode(o.appId ?? APP_ID)), Uint8Array.of(0x01), u32(this.counter));
    const raw = new Uint8Array(await crypto.subtle.sign(ES256, (o.signer ?? this).keys.privateKey, o.singleHash ? cat(authData, clientDataHash) : await sha256(cat(authData, clientDataHash))));
    return std(cbor(new Map<string, any>([["signature", der(raw)], ["authenticatorData", authData]])));
  }
}
