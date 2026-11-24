import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { attested, bindingHash, issueChallenge } from "../src/attest";
import { ANDROID_PACKAGE } from "../src/playintegrity";
import { goodVerdict, playFake, type Verdict } from "./play-fake";

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const hashFor = async (challenge: string, data: string) => b64url(await bindingHash(challenge, data));

// a fresh challenge and a token the fake decodes to a verdict for (data), changed by `edit`
async function attempt(data: string, edit: (v: Verdict) => void = () => {}, status = 200) {
  const challenge = await issueChallenge(env);
  const verdict = goodVerdict(await hashFor(challenge, data));
  edit(verdict);
  playFake({ tok: verdict }, status);
  return { challenge, ok: await attested(env, "android", { challenge, token: "tok" }, data) };
}

describe("Play Integrity", () => {
  it("accepts a recognized app on a device that meets integrity", async () => {
    expect((await attempt("a@firm.test")).ok).toBe(true);
  });

  it("is off, and needs nothing from the app, until the service account is set", async () => {
    const calls = playFake({});
    const off = Object.create(env, { PLAY_INTEGRITY_SA: { value: undefined } });
    expect(await attested(off, "android", undefined, "a@firm.test")).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses a missing or malformed attestation", async () => {
    playFake({});
    expect(await attested(env, "android", undefined, "x")).toBe(false);
    expect(await attested(env, "android", { challenge: "c" }, "x")).toBe(false);
    expect(await attested(env, "android", { token: "t" }, "x")).toBe(false);
    expect(await attested(env, "android", { challenge: 1, token: "t" }, "x")).toBe(false);
  });

  it("refuses a challenge it never issued or that has expired", async () => {
    playFake({ tok: goodVerdict(await hashFor("made-up", "x")) });
    expect(await attested(env, "android", { challenge: "made-up", token: "tok" }, "x")).toBe(false);
    const challenge = await issueChallenge(env);
    await env.CONTROL.prepare("UPDATE app_challenges SET expires_at = ?").bind(Date.now() - 1).run();
    playFake({ tok: goodVerdict(await hashFor(challenge, "x")) });
    expect(await attested(env, "android", { challenge, token: "tok" }, "x")).toBe(false);
  });

  it("refuses a replayed challenge", async () => {
    const { challenge, ok } = await attempt("a@firm.test");
    expect(ok).toBe(true);
    playFake({ tok: goodVerdict(await hashFor(challenge, "a@firm.test")) });
    expect(await attested(env, "android", { challenge, token: "tok" }, "a@firm.test")).toBe(false);
  });

  it("refuses a token made for other request data", async () => {
    const challenge = await issueChallenge(env);
    playFake({ tok: goodVerdict(await hashFor(challenge, "a@firm.test")) });
    expect(await attested(env, "android", { challenge, token: "tok" }, "b@firm.test")).toBe(false);
  });

  it("refuses another package", async () => {
    expect((await attempt("x", (v) => (v.requestDetails.requestPackageName = "com.evil.app"))).ok).toBe(false);
    expect((await attempt("x", (v) => (v.appIntegrity.packageName = "com.evil.app"))).ok).toBe(false);
    expect(ANDROID_PACKAGE).toBe("com.lazycollect.lazycollect");
  });

  it("refuses an app Google does not recognize and a device that fails integrity", async () => {
    expect((await attempt("x", (v) => (v.appIntegrity.appRecognitionVerdict = "UNRECOGNIZED_VERSION"))).ok).toBe(false);
    expect((await attempt("x", (v) => (v.appIntegrity.appRecognitionVerdict = "UNEVALUATED"))).ok).toBe(false);
    expect((await attempt("x", (v) => (v.deviceIntegrity.deviceRecognitionVerdict = []))).ok).toBe(false);
    expect((await attempt("x", (v) => (v.deviceIntegrity.deviceRecognitionVerdict = ["MEETS_BASIC_INTEGRITY"]))).ok).toBe(false);
  });

  it("refuses a stale verdict", async () => {
    expect((await attempt("x", (v) => (v.requestDetails.timestampMillis = String(Date.now() - 11 * 60_000)))).ok).toBe(false);
  });

  it("refuses when Google rejects the token", async () => {
    expect((await attempt("x", () => {}, 400)).ok).toBe(false);
  });
});
