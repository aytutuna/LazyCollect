import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { api, linkFrom, mockOutbound, start } from "./helpers";

it("sends the security headers on the link confirm page", async () => {
  const sent = mockOutbound();
  await start("owner@firm.test");
  const res = await api(linkFrom(sent[0]));
  expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await res.text()).not.toContain("<script>");
});

it("serves the client page shell with the same headers", async () => {
  const res = await exports.default.fetch("https://collect.alazy.app/c/abc");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
  // the body only exists when web/ has been built
  if (res.status === 200) {
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('id="app"');
  }
});
