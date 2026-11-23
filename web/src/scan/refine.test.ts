import { describe, expect, it } from "vitest";
import { mapPixels, photoOf, textPage } from "./fixtures";
import { signedArea, startQuad, type Pixels, type Quad } from "./geometry";
import { buildField, placement, refine } from "./refine";

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

  it("places a page straight away only when the model and the edges are both sure", () => {
    const given: Quad = [[100, 100], [400, 100], [400, 500], [100, 500]];
    const edge: Quad = [[102, 99], [401, 101], [399, 501], [101, 499]];
    const sure = placement({ quad: edge, refined: true, support: 0.9 }, given, 0.92, 640, 640);
    expect(sure).toEqual({ quad: edge, sure: true });
    // the model unsure, or the edges backing the page poorly: the editor opens
    expect(placement({ quad: edge, refined: true, support: 0.9 }, given, 0.6, 640, 640).sure).toBe(false);
    expect(placement({ quad: given, refined: false, support: 0.5 }, given, 0.92, 640, 640)).toEqual({ quad: given, sure: false });
    // the worker gave no answer: the model's corners, for a check
    expect(placement(null, given, 0.92, 640, 640)).toEqual({ quad: given, sure: false });
  });

  it("starts the editor from the model's corners when the refined ones have little behind them", () => {
    const given: Quad = [[100, 100], [400, 100], [400, 500], [100, 500]];
    const drifted: Quad = [[100, 100], [400, 100], [440, 540], [100, 500]];
    expect(placement({ quad: drifted, refined: true, support: 0.31 }, given, 0.92, 640, 640)).toEqual({ quad: given, sure: false });
  });

  it("keeps the corners inside the photo, and falls back to the start rectangle when that leaves no outline", () => {
    const out: Quad = [[-20, -10], [700, -10], [700, 660], [-20, 660]];
    expect(placement({ quad: out, refined: true, support: 0.9 }, out, 0.9, 640, 640).quad).toEqual([[0, 0], [640, 0], [640, 640], [0, 640]]);
    const sliver: Quad = [[-50, 10], [-40, 10], [-40, 500], [-50, 500]];
    expect(placement({ quad: sliver, refined: false, support: 0.9 }, sliver, 0.9, 640, 640)).toEqual({ quad: startQuad(640, 640), sure: false });
  });
});

// Lazy Scan's scenes from QuadRefinerTests, drawn as plain rectangles: an upright page on a dark desk with other edges near it
describe("pages with a second edge beside them", () => {
  type Box = [number, number, number, number, number];
  const scene = (boxes: Box[]): Pixels => {
    const img: Pixels = { width: 420, height: 520, data: new Uint8ClampedArray(420 * 520 * 4).fill(255) };
    for (const [x0, y0, x1, y1, v] of boxes) {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.fill(v, (y * 420 + x) * 4, (y * 420 + x) * 4 + 3);
    }
    return img;
  };
  const page: Quad = [[100, 80], [331, 80], [331, 407], [100, 407]];
  const worst = (a: Quad, b: Quad) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
  const diagonal = Math.hypot(420, 520);

  it("is not pulled onto a header bar just inside the page", () => {
    // a tinted bar across the top of the page (its edge softer than the page's, as a header bar is), its edge nearer the outline than the page's own; the outline sits on that bar (0.9 % of the diagonal too low; the page edge must be within a third of the band, 1 %, to win)
    const photo = scene([[0, 0, 420, 520, 30], [100, 80, 331, 407, 235], [100, 86, 331, 116, 200]]);
    const start = page.map((p, i) => (i < 2 ? [p[0], p[1] + 0.009 * diagonal] : p)) as Quad;
    expect(worst(refine(photo, start).quad, page)).toBeLessThanOrEqual(0.003 * diagonal);
  });

  it("is not pushed from its own edges onto a folder under it", () => {
    const photo = scene([[0, 0, 420, 520, 30], [88, 68, 343, 419, 175], [100, 80, 331, 407, 235]]);
    const result = refine(photo, page);
    expect(worst(result.quad, page)).toBeLessThanOrEqual(0.5);
    expect(result.support).toBeGreaterThanOrEqual(0.95);
  });

  it("does not take an equally sharp edge just outside for the side", () => {
    // a gray card under the page whose edges are as sharp as the page's; an outline 2 px inside the page moves onto the page's edges
    const photo = scene([[0, 0, 420, 520, 20], [88, 68, 343, 419, 128], [100, 80, 331, 407, 232]]);
    const inside = page.map((p, i) => [p[0] + (i === 0 || i === 3 ? 2 : -2), p[1] + (i < 2 ? 2 : -2)]) as Quad;
    const result = refine(photo, inside);
    expect(result.refined).toBe(true);
    expect(worst(result.quad, page)).toBeLessThanOrEqual(1);
    expect(result.support).toBeGreaterThanOrEqual(0.95);
  });
});
