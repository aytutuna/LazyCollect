import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("reports ok on /api/health", async () => {
  const res = await exports.default.fetch("http://example.com/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it("marks API responses nosniff and uncached", async () => {
  const res = await exports.default.fetch("http://example.com/api/health");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("no-store");
});
