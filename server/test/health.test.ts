import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("reports ok on /api/health", async () => {
  const res = await exports.default.fetch("http://example.com/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
