import { describe, expect, it } from "vitest";
import { SIDE, acceptable, decodeHeatmap, modelInput } from "./corners";
import { applyFilter } from "./filters";
import { boxBlur, mapPixels, photoOf, textPage } from "./fixtures";
import { aspect, fromCorners, isConvex, warp, type Pixels, type Quad } from "./geometry";
import { frameIssues, pageIssues } from "./quality";

// four Gaussian blobs of the given peaks, one channel each, on a 64 x 64 map
function heat(points: [number, number][], peaks = [1, 1, 1, 1]): Float32Array {
  const n = 64;
  const out = new Float32Array(4 * n * n);
  points.forEach(([px, py], ch) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        out[ch * n * n + y * n + x] = peaks[ch] * Math.exp(-((x + 0.5 - px * n) ** 2 + (y + 0.5 - py * n) ** 2) / 8);
      }
    }
  });
  return out;
}

const corners: [number, number][] = [[0.2, 0.15], [0.8, 0.2], [0.85, 0.85], [0.15, 0.8]];

describe("heatmap", () => {
  it("reads the corners back", () => {
    const found = decodeHeatmap(heat(corners), 64, 64)!;
    corners.forEach((c, i) => {
      expect(found.quad[i][0]).toBeCloseTo(c[0], 2);
      expect(found.quad[i][1]).toBeCloseTo(c[1], 2);
    });
    expect(found.confidence).toBeGreaterThan(0.95);
  });

  it("takes the weakest peak as the confidence", () => {
    expect(decodeHeatmap(heat(corners, [1, 0.6, 0.9, 1]), 64, 64)!.confidence).toBeCloseTo(0.6, 1);
  });

  it("takes the largest blob when a channel has two", () => {
    const h = heat(corners);
    const speck = heat([[0.95, 0.05], [0, 0], [0, 0], [0, 0]], [0.35, 0, 0, 0]);
    for (let i = 0; i < 64 * 64; i++) h[i] = Math.max(h[i], speck[i]);
    const found = decodeHeatmap(h, 64, 64)!;
    expect(found.quad[0][0]).toBeCloseTo(0.2, 2);
  });

  it("gives nothing when a corner is missing or the outline is not convex", () => {
    expect(decodeHeatmap(heat(corners, [1, 1, 0.2, 1]), 64, 64)).toBeNull();
    expect(decodeHeatmap(heat([corners[0], corners[2], corners[1], corners[3]]), 64, 64)).toBeNull();
  });

  it("applies the sanity checks", () => {
    const sure = decodeHeatmap(heat(corners), 64, 64)!;
    expect(acceptable(sure, 800, 600)).toBe(true);
    expect(acceptable({ ...sure, confidence: 0.4 }, 800, 600)).toBe(false);
    const tiny = decodeHeatmap(heat(corners.map(([x, y]) => [0.4 + x * 0.1, 0.4 + y * 0.1])), 64, 64)!;
    expect(acceptable(tiny, 800, 600)).toBe(false);
  });
});

describe("model input", () => {
  it("lays the planes out blue, green, red", () => {
    const data = new Uint8ClampedArray(SIDE * SIDE * 4);
    for (let i = 0; i < SIDE * SIDE; i++) data.set([255, 128, 0, 255], i * 4);
    const input = modelInput({ width: SIDE, height: SIDE, data });
    expect(input).toHaveLength(3 * SIDE * SIDE);
    expect(input[0]).toBeCloseTo(0, 5);
    expect(input[SIDE * SIDE]).toBeCloseTo(128 / 255, 5);
    expect(input[2 * SIDE * SIDE]).toBeCloseTo(1, 5);
  });

  it("matches pixel centres when it shrinks", () => {
    const data = new Uint8ClampedArray(512 * 512 * 4);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) data.set([x % 2 ? 255 : 0, 0, 0, 255], (y * 512 + x) * 4);
    // red alternates 0, 255 across columns; input pixel 0 reads the photo at x = 0.5, halfway between the first two
    expect(modelInput({ width: 512, height: 512, data })[2 * SIDE * SIDE]).toBeCloseTo(0.5, 5);
  });
});

describe("geometry", () => {
  const quad: Quad = [[300, 200], [900, 260], [960, 800], [240, 760]];

  it("names corners from their place", () => {
    expect(fromCorners([quad[2], quad[3], quad[0], quad[1]])).toEqual(quad);
    expect(fromCorners([quad[0], quad[3], quad[2], quad[1]])).toEqual(quad);
    expect(isConvex(quad)).toBe(true);
    expect(isConvex([quad[0], quad[2], quad[1], quad[3]])).toBe(false);
  });

  it("flattens a photographed page back to the page", () => {
    const page = textPage(1000, 1400);
    const photo = photoOf(page, quad, 1200, 900);
    const flat = warp(photo, quad, 1000, 1400)!;
    let diff = 0;
    for (let i = 0; i < page.data.length; i += 4) diff += Math.abs(page.data[i] - flat.data[i]);
    expect(diff / (page.data.length / 4)).toBeLessThan(12);
  });

  it("finds the sheet's shape through the perspective", () => {
    const f = 1000;
    const [W, H] = [210, 297];
    const project = (turnX: number, turnY: number): Quad =>
      [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]].map(([x, y]) => {
        const y1 = y * Math.cos(turnX);
        const z1 = y * Math.sin(turnX);
        const x2 = x * Math.cos(turnY) + z1 * Math.sin(turnY);
        const z2 = -x * Math.sin(turnY) + z1 * Math.cos(turnY) + 600;
        return [(f * x2) / z2 + 500, (f * y1) / z2 + 400];
      }) as Quad;
    for (const [a, b] of [[0.5, 0.3], [-0.4, 0.5], [0.3, -0.2]]) {
      expect(aspect(project(a, b), 1000, 800)).toBeCloseTo(W / H, 1);
    }
    expect(aspect(project(0, 0), 1000, 800)).toBeCloseTo(W / H, 2);
  });
});

describe("quality", () => {
  // paper as a photo has it: a little under full white
  const page = mapPixels(textPage(1000, 1400), (v) => (v === 255 ? 215 : v));

  it("passes a sharp, bright page", () => {
    expect(pageIssues(page)).toEqual([]);
  });

  it("flags blur but not a slight softness", () => {
    expect(pageIssues(boxBlur(page, 1))).not.toContain("blur");
    expect(pageIssues(boxBlur(page, 12))).toContain("blur");
  });

  it("does not call an empty page blurry", () => {
    const blank: Pixels = { width: 800, height: 1000, data: new Uint8ClampedArray(800 * 1000 * 4).fill(250) };
    expect(pageIssues(blank)).toEqual([]);
  });

  it("flags a blown-out patch", () => {
    const glared = mapPixels(page, (v, x, y) => (x >= 300 && x < 700 && y >= 300 && y < 700 ? 255 : v));
    expect(pageIssues(glared)).toContain("glare");
  });

  it("flags a dark page", () => {
    expect(pageIssues(mapPixels(page, (v) => v * 0.25))).toContain("dark");
  });

  it("flags a page that touches the frame or fills little of it", () => {
    expect(frameIssues([[100, 100], [700, 100], [700, 500], [100, 500]], 0.9, 800, 600)).toEqual([]);
    expect(frameIssues([[0, 100], [700, 100], [700, 500], [0, 500]], 0.9, 800, 600)).toEqual(["cut"]);
    expect(frameIssues([[100, 100], [700, 100], [700, 500], [100, 500]], 0.55, 800, 600)).toEqual(["cut"]);
    expect(frameIssues([[300, 200], [500, 200], [500, 400], [300, 400]], null, 800, 600)).toEqual(["small"]);
  });
});

describe("filters", () => {
  // a page lit from one side: the paper runs from 235 down to 110
  const lit = mapPixels(textPage(600, 800), (v, x) => (v * (235 - (x / 600) * 125)) / 255);
  const at = (img: Pixels, x: number, y: number) => img.data[(y * img.width + x) * 4];

  it("evens the lighting and whitens the paper", () => {
    const flat = applyFilter(lit, "enhanced");
    expect(at(flat, 560, 790)).toBeGreaterThan(235);
    expect(at(flat, 20, 790)).toBeGreaterThan(235);
    expect(at(lit, 560, 790)).toBeLessThan(130);
  });

  it("keeps the ink dark in every filter", () => {
    for (const f of ["enhanced", "gray", "bw"] as const) {
      const img = applyFilter(lit, f);
      let darkest = 255;
      for (let y = 80; y < 94; y++) for (let x = 80; x < 400; x++) darkest = Math.min(darkest, at(img, x, y));
      expect(darkest).toBeLessThan(90);
    }
  });

  it("gives black and white only two levels", () => {
    const bw = applyFilter(lit, "bw");
    let other = 0;
    for (let i = 0; i < bw.data.length; i += 4) if (bw.data[i] !== 0 && bw.data[i] !== 255) other++;
    expect(other).toBe(0);
  });

  it("leaves the original alone", () => {
    expect(applyFilter(lit, "original")).toBe(lit);
  });
});
