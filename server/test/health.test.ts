import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint, keyCheckGate, linkCheck, masterCheck } from "../src/keycheck";
import { api, openRequest, pdf, upload } from "./helpers";
import { hmac } from "../src/util";
import { fingerprint as scriptFingerprint, keyGate, keyProblems } from "../scripts/deploy-lib.mjs";

it("reports ok on /api/health", async () => {
  const res = await exports.default.fetch("http://example.com/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, commit: null });
});

it("names the deployed commit", async () => {
  env.COMMIT = "abc1234";
  try {
    const res = await exports.default.fetch("http://example.com/api/health");
    expect(await res.json()).toEqual({ ok: true, commit: "abc1234" });
  } finally {
    delete env.COMMIT;
  }
});

it("marks API responses nosniff and uncached", async () => {
  const res = await exports.default.fetch("http://example.com/api/health");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("no-store");
});

describe("key check", () => {
  const original = { master: env.MASTER_KEY_NA, hash: env.HASH_KEY };
  const keys = (headers?: Record<string, string>) => api("/api/health/keys", { headers });
  afterEach(() => {
    env.MASTER_KEY_NA = original.master;
    env.HASH_KEY = original.hash;
  });

  it("answers only a caller that holds the link key", async () => {
    expect((await keys()).status).toBe(404);
    expect((await keys({ "X-Key-Check": "nope" })).status).toBe(404);
    const res = await keys({ "X-Key-Check": await keyCheckGate(env) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ master: "none", masterFingerprint: await fingerprint(original.master), link: "none" });
  });

  it("opens a stored document key and a stored link with the right keys", async () => {
    const { req, path } = await openRequest();
    expect((await upload(path, req.items[0].id, pdf(500))).status).toBe(201);
    expect(await masterCheck(env)).toBe("ok");
    expect(await linkCheck(env)).toBe("ok");
    const res = await keys({ "X-Key-Check": await keyCheckGate(env) });
    expect(await res.json()).toMatchObject({ master: "ok", link: "ok" });
  });

  it("fails when the master key is another one", async () => {
    const { req, path } = await openRequest();
    await upload(path, req.items[0].id, pdf(500));
    env.MASTER_KEY_NA = btoa("a-different-master-key-32-bytes!!");
    expect(await masterCheck(env)).toBe("fail");
    expect(await fingerprint(env.MASTER_KEY_NA)).not.toBe(await fingerprint(original.master));
  });

  it("fails when the link key is another one", async () => {
    await openRequest();
    const gate = await keyCheckGate(env);
    env.HASH_KEY = "another-salt";
    expect(await linkCheck(env)).toBe("fail");
    expect((await keys({ "X-Key-Check": gate })).status).toBe(404);
  });

  it("matches what the deploy script computes", async () => {
    expect(await scriptFingerprint(original.master)).toBe(await fingerprint(original.master));
    expect(await keyGate(original.hash)).toBe(await hmac(original.hash, "key-check"));
  });

  it("stops a deploy when either key is wrong", async () => {
    const good = { master: "ok", masterFingerprint: await fingerprint(original.master), link: "ok" };
    expect(await keyProblems(200, good, original.master)).toEqual([]);
    expect(await keyProblems(200, { ...good, master: "fail" }, original.master)).toHaveLength(1);
    expect(await keyProblems(200, { ...good, link: "fail" }, original.master)).toHaveLength(1);
    expect(await keyProblems(200, good, "the master key from another file")).toHaveLength(1);
    expect(await keyProblems(404, null, original.master)).toHaveLength(1);
  });
});
