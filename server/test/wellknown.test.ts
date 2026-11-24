import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Authenticator } from "./authenticator";
import { codeStep, pendingOptions, pendingVerify, addPasskey, PENDING } from "./passkey-flow";
import { api, login } from "./helpers";
import { androidCerts } from "../src/wellknown";

const get = (path: string) => exports.default.fetch(`https://collect.alazy.app${path}`, { redirect: "manual" });
const FP = "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5";
// base64url of those 32 bytes
const FP_ORIGIN = "android:apk-key-hash:FG3pg8VzBlDY7rmVLzT8ZBagg0LmHb6oigSWsj_PROU";

afterEach(() => {
  env.ANDROID_CERT_SHA256 = undefined;
});

describe("assetlinks.json", () => {
  it("names the package and the valid fingerprints from the variable, in colon form", async () => {
    env.ANDROID_CERT_SHA256 = `${FP.toLowerCase().replaceAll(":", "")}, 00:11`;
    const res = await get("/.well-known/assetlinks.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("location")).toBeNull();
    const [entry] = await res.json<any[]>();
    expect(entry.relation).toContain("delegate_permission/common.get_login_creds");
    expect(entry.target).toEqual({ namespace: "android_app", package_name: "com.lazycollect.lazycollect", sha256_cert_fingerprints: [FP] });
  });

  it("warns about a bad entry once, not on every request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      env.ANDROID_CERT_SHA256 = `${FP}, nonsense`;
      for (let i = 0; i < 3; i++) expect(androidCerts(env)).toEqual([FP]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("is valid with no fingerprint until the release key is known", async () => {
    const [entry] = await (await get("/.well-known/assetlinks.json")).json<any[]>();
    expect(entry.target.sha256_cert_fingerprints).toEqual([]);
  });
});

describe("apple-app-site-association", () => {
  it("lists the app for passkeys and for client links, as plain JSON", async () => {
    const res = await get("/.well-known/apple-app-site-association");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("location")).toBeNull();
    const body = await res.json<any>();
    expect(body.webcredentials.apps).toEqual(["8XT2U634Z4.com.lazycollect.lazycollect"]);
    expect(body.applinks.details[0]).toEqual({ appIDs: ["8XT2U634Z4.com.lazycollect.lazycollect"], components: [{ "/": "/c/*" }] });
  });
});

describe("passkeys from the Android app", () => {
  async function enrolled() {
    const cookie = await login();
    const key = await Authenticator.create();
    return { cookie, key };
  }

  it("accepts the app's own origin once its fingerprint is set, for adding and for signing in", async () => {
    env.ANDROID_CERT_SHA256 = FP.replaceAll(":", "").toLowerCase();
    const { cookie, key } = await enrolled();
    const options = await (await api("/api/passkeys/options", { method: "POST", cookie })).json<any>();
    const added = await api("/api/passkeys", { method: "POST", cookie, body: { response: await key.register(options, FP_ORIGIN) } });
    expect(added.status).toBe(201);
    const { cookies } = await codeStep("owner@firm.test");
    const { options: ask } = await (await pendingOptions(cookies[PENDING])).json<any>();
    expect((await pendingVerify(cookies[PENDING], await key.assert(ask, { origin: FP_ORIGIN }))).status).toBe(200);
  });

  it("refuses an Android origin for another certificate, and any while no fingerprint is set", async () => {
    const { cookie, key } = await enrolled();
    const asked = async () => (await (await api("/api/passkeys/options", { method: "POST", cookie })).json<any>());
    const other = "android:apk-key-hash:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect((await api("/api/passkeys", { method: "POST", cookie, body: { response: await key.register(await asked(), FP_ORIGIN) } })).status).toBe(400);
    env.ANDROID_CERT_SHA256 = FP;
    expect((await api("/api/passkeys", { method: "POST", cookie, body: { response: await key.register(await asked(), other) } })).status).toBe(400);
    expect((await addPasskey(cookie, key)).status).toBe(201);
  });
});
