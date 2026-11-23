import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { fromHeader } from "../src/mail";

describe("client mail sender", () => {
  it("names the account and keeps the shared address", () => {
    expect(fromHeader(env, "Tuna Tax Inc.")).toBe('"Tuna Tax Inc. via Lazy Collect" <noreply@alazy.app>');
  });

  it("strips quotes, brackets, commas and line breaks from the name", () => {
    const from = fromHeader(env, 'Smith, "Jones" <x@evil.test>\r\nBcc: a@b.test\\');
    expect(from).toBe('"Smith Jones x@evil.test Bcc: a@b.test via Lazy Collect" <noreply@alazy.app>');
    expect(from).toMatch(/^"[^"<>\r\n,\\]+" <noreply@alazy\.app>$/);
  });

  it("caps a long name and falls back when nothing is left", () => {
    const long = fromHeader(env, "A".repeat(200));
    expect(long).toBe(`"${"A".repeat(60)} via Lazy Collect" <noreply@alazy.app>`);
    expect(fromHeader(env, '<>",\r\n')).toBe('"Sender via Lazy Collect" <noreply@alazy.app>');
  });
});
