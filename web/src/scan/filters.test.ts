import { describe, expect, it } from "vitest";
import { applyFilter } from "./filters";
import { checksum, shadowedPage } from "./fixtures";
import type { Pixels } from "./geometry";

// the same pages and checksums as Lazy Scan's DocumentEnhancerTests, so both apps give the same bytes
const luma = (img: Pixels, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return Math.floor((299 * img.data[i] + 587 * img.data[i + 1] + 114 * img.data[i + 2] + 500) / 1000);
};

// the luma range of the pixels of one kind of the shadowed page: 0 paper, 1 print
function lumas(img: Pixels, kind: number) {
  let min = 255;
  let max = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const ink = x >= 24 && x < img.width - 24 && y >= 70 && y < img.height - 30 && (y - 70) % 12 < 3 && Math.floor((x - 24) / 18) % 5 !== 4;
      const stamp = x >= 150 && x < 200 && y >= 24 && y < 52;
      if ((stamp ? 2 : ink ? 1 : 0) !== kind) continue;
      const v = luma(img, x, y);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  return { min, max };
}

describe("Lazy Scan's page clean-up", () => {
  const page = shadowedPage();

  it("starts from the same pixels", () => {
    expect(checksum(page)).toBe(0x4329e79a);
    expect(checksum(shadowedPage(false))).toBe(0x8f960753);
    expect(checksum(shadowedPage(false, true))).toBe(0x2c86f2c0);
  });

  it("gives the same bytes as the app", () => {
    expect(checksum(applyFilter(page, "enhanced"))).toBe(0x70604295);
    expect(checksum(applyFilter(page, "gray"))).toBe(0xec4526a3);
    expect(checksum(applyFilter(page, "bw"))).toBe(0x43422875);
    // no colour on the page: the enhanced page is stored gray
    expect(checksum(applyFilter(shadowedPage(false), "enhanced"))).toBe(0xf81468d6);
    expect(checksum(applyFilter(shadowedPage(false, true), "gray"))).toBe(0x13cf7a4c);
  });

  it("evens a shadowed page out to one white paper and keeps the print black", () => {
    const before = lumas(page, 0);
    expect(before.max - before.min).toBeGreaterThanOrEqual(100);
    const out = applyFilter(page, "gray");
    expect(lumas(out, 0).min).toBeGreaterThanOrEqual(250);
    expect(lumas(out, 1).max).toBeLessThanOrEqual(10);
  });

  it("evens a whiteboard out without stretching its print to black", () => {
    const board = applyFilter(page, "whiteboard");
    expect(lumas(board, 0).min).toBeGreaterThanOrEqual(245);
    expect(lumas(board, 1).min).toBeGreaterThan(30);
    expect(lumas(applyFilter(page, "enhanced"), 1).max).toBeLessThanOrEqual(10);
  });

  it("pushes a whiteboard's colours away from gray", () => {
    const data = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const mark = x >= 22 && x < 42 && y >= 22 && y < 42;
        data.set([mark ? 150 : 230, mark ? 130 : 230, mark ? 130 : 230], (y * 64 + x) * 4);
      }
    }
    const board = applyFilter({ width: 64, height: 64, data }, "whiteboard");
    const mid = (32 * 64 + 32) * 4;
    expect(board.data[mid] - board.data[mid + 1]).toBeGreaterThanOrEqual(30);
    expect(board.data[mid] - board.data[mid + 1]).toBeLessThanOrEqual(45);
    expect(board.data[mid + 1]).toBe(board.data[mid + 2]);
    expect(luma(board, 4, 4)).toBeGreaterThanOrEqual(250);
  });

  it("leaves the original alone", () => {
    expect(applyFilter(page, "original")).toBe(page);
  });
});
