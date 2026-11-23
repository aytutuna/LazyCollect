import { signedArea, type Pixels, type Quad } from "./geometry";

export type Issue = "blur" | "glare" | "dark" | "cut" | "small";

// The checks read the page at one size, so a threshold means the same on a 640 px live frame and a 3000 px photo.
export const ANALYSIS = 640;
// Variance of the Laplacian of the sharpest tenth of the page (see quality.test.ts for the numbers it was set from)
export const BLUR_BELOW = 60;
// a patch of near-white cells this large (share of the page) is glare; a page that is all white is just bright paper
export const GLARE_FROM = 0.03;
export const GLARE_UNTIL = 0.6;
const CLIPPED = 252;
export const DARK_BELOW = 75;
// the page covers less than this share of the frame: too far away
export const SMALL_BELOW = 0.3;
const EDGE_MARGIN = 0.012;
export const CUT_CONFIDENCE = 0.6;

// the page averaged down (never up) to at most ANALYSIS pixels on its long side, as luminance
function reduce(page: Pixels): { w: number; h: number; y: Float32Array; clipped: Uint8Array } {
  const k = Math.max(1, Math.max(page.width, page.height) / ANALYSIS);
  const w = Math.floor(page.width / k);
  const h = Math.floor(page.height / k);
  const y = new Float32Array(w * h);
  const clipped = new Uint8Array(w * h);
  const d = page.data;
  for (let j = 0; j < h; j++) {
    const y0 = Math.floor(j * k);
    const y1 = Math.max(y0 + 1, Math.min(page.height, Math.floor((j + 1) * k)));
    for (let i = 0; i < w; i++) {
      const x0 = Math.floor(i * k);
      const x1 = Math.max(x0 + 1, Math.min(page.width, Math.floor((i + 1) * k)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * page.width + xx) * 4;
          r += d[o];
          g += d[o + 1];
          b += d[o + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      y[j * w + i] = (0.299 * r + 0.587 * g + 0.114 * b) / n;
      clipped[j * w + i] = Math.min(r, g, b) / n >= CLIPPED ? 1 : 0;
    }
  }
  return { w, h, y, clipped };
}

// the sharpest tenth of 8 x 8 tiles by variance of the Laplacian; a page with nothing on it gives null
export function sharpness(y: Float32Array, w: number, h: number): number | null {
  const lap = new Float32Array(w * h);
  for (let j = 1; j < h - 1; j++) {
    for (let i = 1; i < w - 1; i++) {
      const o = j * w + i;
      lap[o] = y[o - 1] + y[o + 1] + y[o - w] + y[o + w] - 4 * y[o];
    }
  }
  const tiles = 8;
  const scores: number[] = [];
  let lo = 255;
  let hi = 0;
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const x0 = Math.max(Math.floor((tx * w) / tiles), 1);
      const x1 = Math.min(Math.floor(((tx + 1) * w) / tiles), w - 1);
      const y0 = Math.max(Math.floor((ty * h) / tiles), 1);
      const y1 = Math.min(Math.floor(((ty + 1) * h) / tiles), h - 1);
      let sum = 0;
      let sq = 0;
      let n = 0;
      for (let j = y0; j < y1; j++) {
        for (let i = x0; i < x1; i++) {
          const v = lap[j * w + i];
          sum += v;
          sq += v * v;
          n++;
          lo = Math.min(lo, y[j * w + i]);
          hi = Math.max(hi, y[j * w + i]);
        }
      }
      if (n) scores.push(sq / n - (sum / n) ** 2);
    }
  }
  if (hi - lo < 40 || !scores.length) return null;
  scores.sort((a, b) => a - b);
  return scores[Math.min(scores.length - 1, Math.floor(scores.length * 0.9))];
}

// the largest share of the page a 4-connected patch of clipped 8 x 8 cells covers
export function glareShare(clipped: Uint8Array, w: number, h: number): number {
  const cell = 8;
  const cw = Math.floor(w / cell);
  const ch = Math.floor(h / cell);
  if (!cw || !ch) return 0;
  const on = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      let n = 0;
      for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) n += clipped[(j * cell + dy) * w + i * cell + dx];
      on[j * cw + i] = n >= cell * cell * 0.9 ? 1 : 0;
    }
  }
  let best = 0;
  const stack: number[] = [];
  for (let s = 0; s < on.length; s++) {
    if (on[s] !== 1) continue;
    on[s] = 2;
    stack.push(s);
    let count = 0;
    while (stack.length) {
      const at = stack.pop()!;
      count++;
      const x = at % cw;
      const y = (at - x) / cw;
      for (const next of [x > 0 ? at - 1 : -1, x < cw - 1 ? at + 1 : -1, y > 0 ? at - cw : -1, y < ch - 1 ? at + cw : -1]) {
        if (next >= 0 && on[next] === 1) {
          on[next] = 2;
          stack.push(next);
        }
      }
    }
    best = Math.max(best, count);
  }
  return best / (cw * ch);
}

export function meanLuminance(y: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < y.length; i++) sum += y[i];
  return sum / y.length;
}

// Problems with the flattened page itself: blur, glare, too dark.
export function pageIssues(page: Pixels): Issue[] {
  const { w, h, y, clipped } = reduce(page);
  const issues: Issue[] = [];
  const sharp = sharpness(y, w, h);
  if (sharp !== null && sharp < BLUR_BELOW) issues.push("blur");
  const glare = glareShare(clipped, w, h);
  if (glare >= GLARE_FROM && glare <= GLARE_UNTIL) issues.push("glare");
  if (meanLuminance(y) < DARK_BELOW) issues.push("dark");
  return issues;
}

// Problems with where the page sits in a frame of width x height: a corner at or past the frame's edge (or, when the model
// gave a confidence, a weak one) means a cut-off page; a small share of the frame means it is too far away.
export function frameIssues(quad: Quad, confidence: number | null, width: number, height: number): Issue[] {
  const issues: Issue[] = [];
  const mx = width * EDGE_MARGIN;
  const my = height * EDGE_MARGIN;
  const touching = quad.some((p) => p[0] <= mx || p[1] <= my || p[0] >= width - mx || p[1] >= height - my);
  if (touching || (confidence !== null && confidence < CUT_CONFIDENCE)) issues.push("cut");
  if (signedArea(quad) / (width * height) < SMALL_BELOW) issues.push("small");
  return issues;
}
