import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { attestKey, attested, bindingHash, issueChallenge } from "../src/attest";
import "reflect-metadata";
import { X509Certificate } from "@peculiar/x509";
import { APPLE_ROOT, verifyAttestation } from "../src/appattest";
import { APP_ID, Ca, DEVELOPMENT, Device } from "./appattest-device";

let ca: Ca;
beforeAll(async () => {
  ca = await Ca.create();
  env.APP_ATTEST_ROOT = ca.rootPem;
  env.APP_ATTEST_ENV = "any";
});

const keyRows = async () => (await env.CONTROL.prepare("SELECT * FROM app_keys").all<any>()).results;

// the challenge bound to the fixed data an attestation carries
async function attestWith(device: Device, edit: Parameters<Device["attest"]>[2] = {}, data = "attest") {
  const challenge = await issueChallenge(env);
  const attestation = await device.attest(ca, await bindingHash(challenge, data), edit);
  return { challenge, attestation };
}

async function attestedDevice() {
  const device = await Device.create();
  const { challenge, attestation } = await attestWith(device);
  expect(await attestKey(env, device.keyId, challenge, attestation)).toBe(true);
  return device;
}

// a challenge for a request about (data), and the assertion a device makes for it
async function assertion(device: Device, data: string, edit: Parameters<Device["assert"]>[1] = {}) {
  const challenge = await issueChallenge(env);
  return { challenge, key_id: device.keyId, assertion: await device.assert(await bindingHash(challenge, data), edit) };
}

describe("App Attest attestation", () => {
  it("stores the key of a good attestation", async () => {
    const device = await attestedDevice();
    const [row] = await keyRows();
    expect(row).toMatchObject({ key_id: device.keyId, counter: 0, env: "production" });
  });

  it("knows a development key from a production one and enforces the configured environment", async () => {
    const device = await Device.create();
    const { challenge, attestation } = await attestWith(device, { aaguid: DEVELOPMENT });
    const hash = await bindingHash(challenge, "attest");
    expect((await verifyAttestation(env, device.keyId, attestation, hash))?.env).toBe("development");
    const production = Object.create(env, { APP_ATTEST_ENV: { value: "production" } });
    expect(await verifyAttestation(production, device.keyId, attestation, hash)).toBeNull();
  });

  it("refuses another app, a chain to another root, a wrong nonce, a wrong key id and a counter that is not zero", async () => {
    const device = await Device.create();
    const bad = async (edit: Parameters<Device["attest"]>[2], keyId = device.keyId, issuer = ca) => {
      const challenge = await issueChallenge(env);
      const hash = await bindingHash(challenge, "attest");
      return verifyAttestation(env, keyId, await device.attest(issuer, hash, edit), hash);
    };
    expect(await bad({})).not.toBeNull();
    expect(await bad({ appId: "8XT2U634Z4.com.someone.else" })).toBeNull();
    expect(await bad({ appId: "OTHERTEAM1.com.lazycollect.lazycollect" })).toBeNull();
    expect(await bad({}, device.keyId, await Ca.create())).toBeNull();
    expect(await bad({ nonce: new Uint8Array(32) })).toBeNull();
    expect(await bad({}, (await Device.create()).keyId)).toBeNull();
    expect(await bad({ counter: 1 })).toBeNull();
    expect(await bad({ aaguid: "appattestsandbox0" })).toBeNull();
  });

  it("refuses an attestation made for another challenge", async () => {
    const device = await Device.create();
    const { attestation } = await attestWith(device);
    const other = await issueChallenge(env);
    expect(await attestKey(env, device.keyId, other, attestation)).toBe(false);
    expect(await keyRows()).toHaveLength(0);
  });

  it("refuses a replayed challenge and a key attested twice", async () => {
    const device = await attestedDevice();
    const again = await attestWith(device);
    expect(await attestKey(env, device.keyId, again.challenge, again.attestation)).toBe(false);
    const fresh = await Device.create();
    const { challenge, attestation } = await attestWith(fresh);
    expect(await attestKey(env, fresh.keyId, challenge, attestation)).toBe(true);
    expect(await attestKey(env, fresh.keyId, challenge, attestation)).toBe(false);
  });

  it("trusts Apple's root when no other is configured, and the test chain does not reach it", async () => {
    const root = new X509Certificate(APPLE_ROOT);
    expect(root.subject).toContain("Apple App Attestation Root CA");
    const device = await Device.create();
    const { challenge, attestation } = await attestWith(device);
    const apple = Object.create(env, { APP_ATTEST_ROOT: { value: undefined } });
    expect(await verifyAttestation(apple, device.keyId, attestation, await bindingHash(challenge, "attest"))).toBeNull();
  });

  it("refuses garbage", async () => {
    const challenge = await issueChallenge(env);
    expect(await attestKey(env, "a2V5", challenge, "bm90IGNib3I=")).toBe(false);
  });
});

describe("App Attest assertions", () => {
  it("accepts assertions with a rising counter and stores it", async () => {
    const device = await attestedDevice();
    expect(await attested(env, "ios", await assertion(device, "a@firm.test"), "a@firm.test")).toBe(true);
    expect(await attested(env, "ios", await assertion(device, "a@firm.test"), "a@firm.test")).toBe(true);
    expect((await keyRows())[0].counter).toBe(2);
  });

  it("refuses a counter that stands still or goes backwards", async () => {
    const device = await attestedDevice();
    expect(await attested(env, "ios", await assertion(device, "x", { counter: 5 }), "x")).toBe(true);
    expect(await attested(env, "ios", await assertion(device, "x", { counter: 5 }), "x")).toBe(false);
    expect(await attested(env, "ios", await assertion(device, "x", { counter: 3 }), "x")).toBe(false);
    expect((await keyRows())[0].counter).toBe(5);
    expect(await attested(env, "ios", await assertion(device, "x", { counter: 6 }), "x")).toBe(true);
  });

  it("refuses a replayed challenge", async () => {
    const device = await attestedDevice();
    const first = await assertion(device, "x");
    expect(await attested(env, "ios", first, "x")).toBe(true);
    const replay = { ...(await assertion(device, "x")), challenge: first.challenge };
    expect(await attested(env, "ios", replay, "x")).toBe(false);
  });

  it("refuses an assertion made for other request data", async () => {
    const device = await attestedDevice();
    expect(await attested(env, "ios", await assertion(device, "a@firm.test"), "b@firm.test")).toBe(false);
  });

  it("refuses another app, an unknown key and another device's signature", async () => {
    const device = await attestedDevice();
    expect(await attested(env, "ios", await assertion(device, "x", { appId: "8XT2U634Z4.com.someone.else" }), "x")).toBe(false);
    const stranger = await Device.create();
    expect(await attested(env, "ios", await assertion(stranger, "x"), "x")).toBe(false);
    expect(await attested(env, "ios", await assertion(device, "x", { signer: stranger }), "x")).toBe(false);
    expect(APP_ID).toBe("8XT2U634Z4.com.lazycollect.lazycollect");
  });

  it("refuses a key attested under another environment than the configured one", async () => {
    const device = await Device.create();
    const { challenge, attestation } = await attestWith(device, { aaguid: DEVELOPMENT });
    expect(await attestKey(env, device.keyId, challenge, attestation)).toBe(true);
    expect(await attested(env, "ios", await assertion(device, "x"), "x")).toBe(true);
    const production = Object.create(env, { APP_ATTEST_ENV: { value: "production" } });
    expect(await attested(production, "ios", await assertion(device, "x"), "x")).toBe(false);
  });

  it("refuses a missing or malformed proof", async () => {
    expect(await attested(env, "ios", undefined, "x")).toBe(false);
    expect(await attested(env, "ios", { challenge: await issueChallenge(env) }, "x")).toBe(false);
    expect(await attested(env, "ios", { challenge: await issueChallenge(env), key_id: "a", assertion: "!!" }, "x")).toBe(false);
  });

  it("refuses until App Attest is switched on, unless listed in APP_ATTEST_OFF", async () => {
    const unset = Object.create(env, { APP_ATTEST_ENV: { value: undefined } });
    expect(await attested(unset, "ios", undefined, "x")).toBe(false);
    const off = Object.create(unset, { APP_ATTEST_OFF: { value: "ios" } });
    expect(await attested(off, "ios", undefined, "x")).toBe(true);
    expect(await attestKey(off, "a2V5", await issueChallenge(env), "AA==")).toBe(false);
  });
});
