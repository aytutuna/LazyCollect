import { describe, expect, it } from "vitest";
import { mapPixels, photoOf, textPage } from "./fixtures";
import { signedArea, type Pixels, type Quad } from "./geometry";
import { buildField, refine, trusted } from "./refine";

describe("the refinement", () => {
  const desk = (): { photo: Pixels; page: Quad } => {
    const sheet = mapPixels(textPage(480, 640), (v) => (v === 255 ? 225 : v));
    const page: Quad = [[260, 180], [700, 210], [740, 760], [220, 720]];
    return { photo: photoOf(sheet, page, 1000, 900), page };
  };
  const diagonal = Math.hypot(1000, 900);
  const worst = (a: Quad, b: Quad) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
  const off = (q: Quad, pattern: number): Quad =>
    q.map((p, i) => [p[0] + 0.01 * diagonal * Math.cos(i * 1.7 + pattern * 2.3), p[1] + 0.01 * diagonal * Math.sin(i * 1.7 + pattern * 2.3)]) as Quad;

  it("moves an outline off the page back onto its edges", () => {
    const { photo, page } = desk();
    for (let pattern = 0; pattern < 4; pattern++) {
      const result = refine(photo, off(page, pattern));
      expect(result.refined).toBe(true);
      expect(worst(result.quad, page)).toBeLessThanOrEqual(0.003 * diagonal);
      expect(result.support).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("leaves a page already on its edges where it is", () => {
    const { photo, page } = desk();
    expect(worst(refine(photo, page).quad, page)).toBeLessThanOrEqual(1);
  });

  it("leaves an outline alone on a table with no page", () => {
    const photo: Pixels = { width: 1000, height: 900, data: new Uint8ClampedArray(1000 * 900 * 4).fill(140) };
    const start = off(desk().page, 0);
    const result = refine(photo, start);
    expect(result.refined).toBe(false);
    expect(result.quad).toEqual(start);
    expect(result.support).toBeLessThan(0.2);
  });

  it("searches a large photo small and answers in its own pixels", () => {
    const sheet = mapPixels(textPage(480, 640), (v) => (v === 255 ? 225 : v));
    const page: Quad = [[780, 540], [2100, 630], [2220, 2280], [660, 2160]];
    const photo = photoOf(sheet, page, 3000, 2700);
    const result = refine(photo, page.map((p, i) => [p[0] + 25 * (i % 2 ? 1 : -1), p[1] + 20]) as Quad);
    expect(result.refined).toBe(true);
    expect(worst(result.quad, page)).toBeLessThanOrEqual(0.003 * 3 * diagonal);
    expect(signedArea(result.quad)).toBeGreaterThan(0);
  });

  it("measures no gradient on a flat image", () => {
    const f = buildField({ width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4).fill(255) });
    expect(Math.max(...f.gx)).toBe(0);
  });

  it("trusts a refinement only where edges back it", () => {
    const given: Quad = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const moved: Quad = [[1, 1], [10, 1], [10, 10], [1, 10]];
    expect(trusted({ quad: moved, refined: true, support: 0.9 }, given)).toBe(moved);
    expect(trusted({ quad: moved, refined: true, support: 0.31 }, given)).toBe(given);
    expect(trusted({ quad: given, refined: false, support: 1 }, given)).toBe(given);
  });
});
