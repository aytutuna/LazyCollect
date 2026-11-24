// A stand-in for Apple's signing chain and its App Store Server API: a CA of its own, with the marks Apple's certificates carry,
// signs the transactions the fake API answers with.
import "reflect-metadata";
import { BasicConstraintsExtension, Extension, X509CertificateGenerator } from "@peculiar/x509";
import { BUNDLE_ID, PLAN_PRODUCT } from "../src/apple";

const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;
const encoder = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const std = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const newKeys = () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
const toPem = (der: ArrayBuffer) => `-----BEGIN CERTIFICATE-----\n${std(der).match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----`;
const day = 86_400_000;

type Marks = { leaf?: boolean; intermediate?: boolean };

export class AppleCa {
  private constructor(
    readonly rootPem: string,
    private chain: string[],
    private leafKey: CryptoKey,
  ) {}

  static async create(marks: Marks = {}) {
    const root = await newKeys();
    const mid = await newKeys();
    const leaf = await newKeys();
    const base = { notBefore: new Date(Date.now() - day), notAfter: new Date(Date.now() + 365 * day), signingAlgorithm: ES256 };
    const rootCert = await X509CertificateGenerator.create({
      ...base,
      serialNumber: "01",
      subject: "CN=Test Apple Root",
      issuer: "CN=Test Apple Root",
      signingKey: root.privateKey,
      publicKey: root.publicKey,
      extensions: [new BasicConstraintsExtension(true, undefined, true)],
    });
    const midCert = await X509CertificateGenerator.create({
      ...base,
      serialNumber: "02",
      subject: "CN=Test Apple Worldwide Developer Relations",
      issuer: "CN=Test Apple Root",
      signingKey: root.privateKey,
      publicKey: mid.publicKey,
      extensions: [new BasicConstraintsExtension(true, undefined, true), ...(marks.intermediate === false ? [] : [new Extension("1.2.840.113635.100.6.2.1", false, Uint8Array.of(5, 0))])],
    });
    const leafCert = await X509CertificateGenerator.create({
      ...base,
      serialNumber: "03",
      subject: "CN=Test Prod ECC Mac App Store and iTunes Store Receipt Signing",
      issuer: "CN=Test Apple Worldwide Developer Relations",
      signingKey: mid.privateKey,
      publicKey: leaf.publicKey,
      extensions: marks.leaf === false ? [] : [new Extension("1.2.840.113635.100.6.11.1", false, Uint8Array.of(5, 0))],
    });
    return new AppleCa(toPem(rootCert.rawData), [std(leafCert.rawData), std(midCert.rawData), std(rootCert.rawData)], leaf.privateKey);
  }

  async sign(claims: object): Promise<string> {
    const head = b64url(encoder.encode(JSON.stringify({ alg: "ES256", x5c: this.chain })));
    const body = b64url(encoder.encode(JSON.stringify(claims)));
    const sig = new Uint8Array(await crypto.subtle.sign(ES256, this.leafKey, encoder.encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(sig)}`;
  }
}

export type Sub = { status: number; original: string; transaction?: string; token?: string | null; product?: string; environment?: string; expires?: number; renews?: boolean; revoked?: boolean };

// the fake API's answers, by transaction id; each is signed by whichever CA `ca` points at
export const appleFake = {
  ca: null as AppleCa | null,
  subs: {} as Record<string, Sub>,
  calls: [] as { url: string; auth: string | null }[],
  reset() {
    this.subs = {};
    this.calls = [];
  },
  async transaction(s: Sub, id: string) {
    return this.ca!.sign({
      transactionId: s.transaction ?? id,
      originalTransactionId: s.original,
      bundleId: BUNDLE_ID,
      productId: s.product ?? PLAN_PRODUCT,
      environment: s.environment ?? "Production",
      expiresDate: s.expires ?? Date.now() + 30 * day,
      ...(s.token === null ? {} : { appAccountToken: s.token }),
      ...(s.revoked ? { revocationDate: Date.now() } : {}),
    });
  },
  async handle(url: string, init?: RequestInit): Promise<Response> {
    const auth = new Headers(init?.headers).get("Authorization");
    this.calls.push({ url, auth });
    const id = decodeURIComponent(url.split("/").pop()!);
    const s = this.subs[id];
    if (!s) return Response.json({ errorCode: 4040010 }, { status: 404 });
    return Response.json({
      data: [
        {
          subscriptionGroupIdentifier: "1",
          lastTransactions: [
            {
              originalTransactionId: s.original,
              status: s.status,
              signedTransactionInfo: await this.transaction(s, id),
              signedRenewalInfo: await this.ca!.sign({ autoRenewStatus: s.renews === false ? 0 : 1 }),
            },
          ],
        },
      ],
    });
  },
};
