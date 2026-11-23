import { clampToPhoto, isConvex, scaled, signedArea, startQuad, usable, type Pixels, type Point, type Quad } from "./geometry";

// Moves each side of a page outline found roughly (the corner model's) onto the photo's edge. A port of Lazy Scan's
// QuadRefiner and the parts of its PhotoDocumentDetector it uses (Field, Line, fitLine), the same arithmetic in the same
// order. Within BAND of the diagonal either side of a side, every straight line is scored by the points along the side where
// it passes a ridge of the gradient across it; of the lines scoring at least OUTER_SHARE of the best, the outermost is the
// page's edge. That line is fitted to a fraction of a pixel where its edge is clear. A side whose edge is clear at fewer than
// MIN_SIDE_SUPPORT of its points keeps its place. The refinement is taken only when at least one side moved, the outline stays
// convex, no corner moved more than twice the band and its sides lie on stronger gradient, all told, than the outline given.
const ANALYSIS_LONG_SIDE = 1000;
const EDGE_THRESHOLD = 3;
const VOTE_CAP = 20;
const BAND = 0.03;
const SAMPLES = 48;
const MIN_SIDE_SUPPORT = 0.5;
const SUPPORT_REACH = 1.5;
const OUTER_SHARE = 0.7;
const OUTER_REACH = 1 / 3;

// Lazy Scan corrects a page without asking when the model's confidence and the edges' support for the weakest side both reach
// this (PhotoImport.sureConfidence and minSureSupport); anything less opens the corner editor.
export const SURE = 0.7;

export type Refinement = { quad: Quad; refined: boolean; support: number };

type Field = { w: number; h: number; gx: Float64Array; gy: Float64Array; diagonal: number };
type Line = { nx: number; ny: number; rho: number };

// channel `ch` smoothed by 1-4-6-4-1 across and down, edges repeated: 256 times the level
function smooth(rgba: Uint8ClampedArray, w: number, h: number, ch: number): Int32Array {
  const row = new Int32Array(w + 4);
  const across = new Int32Array(w * (h + 4));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x + 2] = rgba[(y * w + x) * 4 + ch];
    row[0] = row[2];
    row[1] = row[2];
    row[w + 2] = row[w + 1];
    row[w + 3] = row[w + 1];
    const dst = (y + 2) * w;
    for (let x = 0; x < w; x++) across[dst + x] = row[x] + 4 * row[x + 1] + 6 * row[x + 2] + 4 * row[x + 3] + row[x + 4];
  }
  for (let x = 0; x < w; x++) {
    across[x] = across[2 * w + x];
    across[w + x] = across[2 * w + x];
    across[(h + 2) * w + x] = across[(h + 1) * w + x];
    across[(h + 3) * w + x] = across[(h + 1) * w + x];
  }
  const out = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const a = y * w;
    const b = a + w;
    const c = b + w;
    const d = c + w;
    const e = d + w;
    for (let x = 0; x < w; x++) out[a + x] = across[a + x] + 4 * across[b + x] + 6 * across[c + x] + 4 * across[d + x] + across[e + x];
  }
  return out;
}

// the strongest channel's gradient in levels per pixel (0 on the outermost pixels)
export function buildField(img: Pixels): Field {
  const { width: w, height: h } = img;
  const channels = [0, 1, 2].map((c) => smooth(img.data, w, h, c));
  const gx = new Float64Array(w * h);
  const gy = new Float64Array(w * h);
  if (h >= 3 && w >= 3) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        let bestX = 0;
        let bestY = 0;
        let bestM = -1;
        for (let c = 0; c < 3; c++) {
          const ch = channels[c];
          const right = ch[i - w + 1] + 2 * ch[i + 1] + ch[i + w + 1];
          const left = ch[i - w - 1] + 2 * ch[i - 1] + ch[i + w - 1];
          const below = ch[i + w - 1] + 2 * ch[i + w] + ch[i + w + 1];
          const above = ch[i - w - 1] + 2 * ch[i - w] + ch[i - w + 1];
          const dx = right - left;
          const dy = below - above;
          const m = dx * dx + dy * dy;
          if (m > bestM) {
            bestM = m;
            bestX = dx;
            bestY = dy;
          }
        }
        gx[i] = bestX / 2048;
        gy[i] = bestY / 2048;
      }
    }
  }
  return { w, h, gx, gy, diagonal: Math.sqrt(w * w + h * h) };
}

// the gradient at a continuous point, bilinear between pixel centres
function gradientAt(f: Field, x: number, y: number): [number, number] {
  const cx = Math.min(Math.max(x - 0.5, 1), f.w - 2.000001);
  const cy = Math.min(Math.max(y - 0.5, 1), f.h - 2.000001);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const tx = cx - x0;
  const ty = cy - y0;
  const i = y0 * f.w + x0;
  const w = f.w;
  const gxTop = f.gx[i] * (1 - tx) + f.gx[i + 1] * tx;
  const gxBottom = f.gx[i + w] * (1 - tx) + f.gx[i + w + 1] * tx;
  const gyTop = f.gy[i] * (1 - tx) + f.gy[i + 1] * tx;
  const gyBottom = f.gy[i + w] * (1 - tx) + f.gy[i + w + 1] * tx;
  return [gxTop * (1 - ty) + gxBottom * ty, gyTop * (1 - ty) + gyBottom * ty];
}

const through = (p: Point, q: Point): Line => {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  const nx = dy / len;
  const ny = -dx / len;
  return { nx, ny, rho: nx * p[0] + ny * p[1] };
};

function intersect(a: Line, b: Line): Point | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-9) return null;
  return [(a.rho * b.ny - b.rho * a.ny) / det, (a.nx * b.rho - b.nx * a.rho) / det];
}

// total least squares line through the points
function fit(points: Point[]): Line {
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p[0];
    my += p[1];
  }
  mx /= points.length;
  my /= points.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p[0] - mx;
    const dy = p[1] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const half = (sxx - syy) / 2;
  const lambda = (sxx + syy) / 2 + Math.sqrt(half * half + sxy * sxy);
  const ax = lambda - syy;
  const ay = sxy;
  const bx = sxy;
  const by = lambda - sxx;
  let dirX: number;
  let dirY: number;
  if (Math.abs(ax) + Math.abs(ay) >= Math.abs(bx) + Math.abs(by)) {
    dirX = ax;
    dirY = ay;
  } else {
    dirX = bx;
    dirY = by;
  }
  let len = Math.sqrt(dirX * dirX + dirY * dirY);
  if (len === 0) {
    dirX = 1;
    dirY = 0;
    len = 1;
  }
  const nx = -dirY / len;
  const ny = dirX / len;
  return { nx, ny, rho: nx * mx + ny * my };
}

// refitted twice without the points farther from the line than 2.5 times the median distance (and 0.75 px)
export function fitLine(points: Point[]): Line {
  let current = points;
  let line = fit(current);
  for (let pass = 0; pass < 2; pass++) {
    const distances = current.map((p) => Math.abs(line.nx * p[0] + line.ny * p[1] - line.rho));
    const sorted = distances.slice().sort((a, b) => a - b);
    const limit = Math.max(0.75, 2.5 * sorted[Math.floor(sorted.length / 2)]);
    const kept = current.filter((_, i) => distances[i] <= limit);
    if (kept.length < 4 || kept.length === current.length) break;
    current = kept;
    line = fit(current);
  }
  return line;
}

const inField = (f: Field, x: number, y: number) => x >= 1.5 && y >= 1.5 && x <= f.w - 1.5 && y <= f.h - 1.5;

function fitSide(f: Field, p: Point, q: Point, reach: number, outward: number): Line | null {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!(len >= 8) || len > 1e6) return null;
  const nx = dy / len;
  const ny = -dx / len;
  const r = Math.max(2, Math.ceil(reach));
  const span = 2 * r + 1;
  const n = SAMPLES;
  const values = new Float64Array(n * span);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const inside = new Uint8Array(n);
  let used = 0;
  for (let s = 0; s < n; s++) {
    const t = 0.1 + (0.8 * (s + 0.5)) / n;
    const x = p[0] + dx * t;
    const y = p[1] + dy * t;
    xs[s] = x;
    ys[s] = y;
    if (!inField(f, x, y)) continue;
    inside[s] = 1;
    used++;
    for (let k = 0; k < span; k++) {
      const ox = x + nx * (k - r);
      const oy = y + ny * (k - r);
      if (!inField(f, ox, oy)) continue;
      const g = gradientAt(f, ox, oy);
      values[s * span + k] = g[0] * nx + g[1] * ny;
    }
  }
  if (used * 4 < n) return null;

  // each ridge marked a pixel either way, so a line drawn through whole pixels still passes it
  const hits = new Uint8Array(2 * n * span);
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? -1 : 1;
    for (let s = 0; s < n; s++) {
      if (!inside[s]) continue;
      for (let k = 1; k < span - 1; k++) {
        const v = sign * values[s * span + k];
        if (v < EDGE_THRESHOLD) continue;
        if (v < sign * values[s * span + k - 1] || v < sign * values[s * span + k + 1]) continue;
        for (let d = k - 1; d <= k + 1; d++) hits[(side * n + s) * span + d] = 1;
      }
    }
  }
  const counts = new Int32Array(2 * span * span);
  const strengths = new Float64Array(2 * span * span);
  let bestCount = 0;
  let bestIndex = -1;
  let bestNear = Infinity;
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? -1 : 1;
    for (let a = 0; a < span; a++) {
      for (let b = 0; b < span; b++) {
        let count = 0;
        let strength = 0;
        for (let s = 0; s < n; s++) {
          if (!inside[s]) continue;
          const k = Math.round(a + ((b - a) * s) / (n - 1));
          if (!hits[(side * n + s) * span + k]) continue;
          count++;
          strength += Math.min(sign * values[s * span + k], VOTE_CAP);
        }
        const index = (side * span + a) * span + b;
        counts[index] = count;
        strengths[index] = strength;
        // the best line: the most points, the nearer to the side as given on a tie
        const near = Math.abs(a - r) + Math.abs(b - r);
        if (count > bestCount || (count === bestCount && near < bestNear)) {
          bestCount = count;
          bestIndex = index;
          bestNear = near;
        }
      }
    }
  }
  if (bestCount < Math.max(6, MIN_SIDE_SUPPORT * used)) return null;
  let bestSign = 1;
  let bestOut = -Infinity;
  let bestScore = 0;
  let bestStrength = 0;
  let bestStart = r;
  let bestEnd = r;
  const outReach = 2 * r * OUTER_REACH;
  for (let side = 0; side < 2; side++) {
    for (let a = 0; a < span; a++) {
      for (let b = 0; b < span; b++) {
        const index = (side * span + a) * span + b;
        const count = counts[index];
        if (count < OUTER_SHARE * bestCount) continue;
        const outness = outward * (a + b - 2 * r);
        if (outness > outReach && index !== bestIndex) continue;
        if (outness > bestOut || (outness === bestOut && (count > bestScore || (count === bestScore && strengths[index] > bestStrength)))) {
          bestOut = outness;
          bestScore = count;
          bestStrength = strengths[index];
          bestSign = side === 0 ? -1 : 1;
          bestStart = a;
          bestEnd = b;
        }
      }
    }
  }

  const points: Point[] = [];
  for (let s = 0; s < n; s++) {
    if (!inside[s]) continue;
    const centre = Math.round(bestStart + ((bestEnd - bestStart) * s) / (n - 1));
    let at = -1;
    let top = 0;
    for (let k = Math.max(0, centre - 2); k <= Math.min(span - 1, centre + 2); k++) {
      const v = bestSign * values[s * span + k];
      if (v >= EDGE_THRESHOLD && v > top) {
        top = v;
        at = k;
      }
    }
    if (at < 0) continue;
    let delta = 0;
    if (at > 0 && at < span - 1) {
      const before = bestSign * values[s * span + at - 1];
      const after = bestSign * values[s * span + at + 1];
      const den = before - 2 * top + after;
      if (den < 0) delta = Math.min(Math.max((0.5 * (before - after)) / den, -0.5), 0.5);
    }
    const off = at - r + delta;
    points.push([xs[s] + nx * off, ys[s] + ny * off]);
  }
  if (points.length < Math.max(6, MIN_SIDE_SUPPORT * used)) return null;
  return fitLine(points);
}

// how well edges back q: the share of each side backed by an edge, and the sum of the gradient right on the sides
function backing(f: Field, q: Quad): { shares: number[]; fit: number } {
  const shares = [0, 0, 0, 0];
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const e = q[(i + 1) & 3];
    const dx = e[0] - p[0];
    const dy = e[1] - p[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!(len >= 1)) continue;
    const nx = dy / len;
    const ny = -dx / len;
    const pos = new Float64Array(SAMPLES);
    const neg = new Float64Array(SAMPLES);
    const onSide = new Float64Array(SAMPLES);
    let used = 0;
    let sumPos = 0;
    let sumNeg = 0;
    for (let s = 0; s < SAMPLES; s++) {
      const t = 0.1 + (0.8 * (s + 0.5)) / SAMPLES;
      const x = p[0] + dx * t;
      const y = p[1] + dy * t;
      if (!inField(f, x, y)) {
        pos[s] = -1;
        neg[s] = -1;
        continue;
      }
      used++;
      for (let k = -SUPPORT_REACH; k <= SUPPORT_REACH; k += 0.5) {
        const g = gradientAt(f, x + nx * k, y + ny * k);
        const v = g[0] * nx + g[1] * ny;
        pos[s] = Math.max(pos[s], v);
        neg[s] = Math.max(neg[s], -v);
        if (k === 0) onSide[s] = v;
      }
      sumPos += pos[s];
      sumNeg += neg[s];
    }
    if (used * 4 < SAMPLES) continue;
    const sign = sumPos >= sumNeg ? 1 : -1;
    const side = sign > 0 ? pos : neg;
    let backed = 0;
    let on = 0;
    for (let s = 0; s < SAMPLES; s++) {
      if (side[s] >= EDGE_THRESHOLD) backed++;
      if (side[s] >= 0) on += Math.min(Math.max(sign * onSide[s], 0), VOTE_CAP);
    }
    shares[i] = backed / used;
    total += on / (VOTE_CAP * used);
  }
  return { shares, fit: total };
}

// Box-filter minification as Lazy Scan does it: each destination pixel is the mean, rounded down, of the source pixels it covers.
export function minified(img: Pixels, width: number, height: number): Pixels {
  const out = new Uint8ClampedArray(width * height * 4);
  const xRatio = img.width / width;
  const yRatio = img.height / height;
  for (let dy = 0; dy < height; dy++) {
    const sy0 = Math.floor(dy * yRatio);
    const sy1 = Math.max(sy0 + 1, Math.min(img.height, Math.ceil((dy + 1) * yRatio)));
    for (let dx = 0; dx < width; dx++) {
      const sx0 = Math.floor(dx * xRatio);
      const sx1 = Math.max(sx0 + 1, Math.min(img.width, Math.ceil((dx + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let o = (sy * img.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          r += img.data[o];
          g += img.data[o + 1];
          b += img.data[o + 2];
          o += 4;
          count++;
        }
      }
      const di = (dy * width + dx) * 4;
      out[di] = Math.floor(r / count);
      out[di + 1] = Math.floor(g / count);
      out[di + 2] = Math.floor(b / count);
      out[di + 3] = 255;
    }
  }
  return { width, height, data: out };
}

// Where a page found by the model goes, as in Lazy Scan's PhotoImport.modelPlan: the refined corners (kept within the photo),
// placed straight away when the model and the edges are both sure, else shown in the corner editor. One difference: when the
// edges back the refined outline below SURE, the editor starts from the model's corners, not the refined ones. The refiner
// can latch onto a stack of sheets under the page (patent002 of the fixtures: 41 px off at support 0.31 where the model was
// 2.6 px off), and a client asked to check the corners should start from the better guess.
export function placement(r: Refinement | null, given: Quad, confidence: number, width: number, height: number): { quad: Quad; sure: boolean } {
  const found = r ?? { quad: given, refined: false, support: 0 };
  const start = found.refined && found.support < SURE ? given : found.quad;
  const clamped = clampToPhoto(start, width, height);
  const fine = usable(clamped);
  return { quad: fine ? clamped : startQuad(width, height), sure: fine && confidence >= SURE && found.support >= SURE };
}

// `quad` (the photo's pixels) moved onto the edges of `image`, with its edge support
export function refine(image: Pixels, quad: Quad): Refinement {
  const long = Math.max(image.width, image.height);
  let small = image;
  if (long > ANALYSIS_LONG_SIDE) {
    const s = ANALYSIS_LONG_SIDE / long;
    small = minified(image, Math.max(1, Math.round(image.width * s)), Math.max(1, Math.round(image.height * s)));
  }
  if (small.width < 16 || small.height < 16) return { quad, refined: false, support: 0 };
  const field = buildField(small);
  const toX = image.width / small.width;
  const toY = image.height / small.height;
  const q = scaled(quad, 1 / toX, 1 / toY);
  const reach = BAND * field.diagonal;
  const outward = signedArea(q) >= 0 ? 1 : -1;
  const lines: Line[] = [];
  let moved = 0;
  for (let i = 0; i < 4; i++) {
    const line = fitSide(field, q[i], q[(i + 1) & 3], reach, outward);
    if (line) {
      lines.push(line);
      moved++;
    } else if (Math.hypot(q[i][0] - q[(i + 1) & 3][0], q[i][1] - q[(i + 1) & 3][1]) >= 1) {
      lines.push(through(q[i], q[(i + 1) & 3]));
    } else {
      return { quad, refined: false, support: 0 };
    }
  }
  const given = backing(field, q);
  const corners: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const c = intersect(lines[(i + 3) & 3], lines[i]);
    if (!c) return { quad, refined: false, support: Math.min(...given.shares) };
    corners.push(c);
  }
  const result = corners as Quad;
  const near = result.every((c, i) => Math.hypot(c[0] - q[i][0], c[1] - q[i][1]) <= 2 * reach);
  // only an outline lying on its edges better than the one given: a page already on its edges is not moved onto another edge near it
  if (moved > 0 && isConvex(result) && near) {
    const found = backing(field, result);
    if (found.fit > given.fit) return { quad: scaled(result, toX, toY), refined: true, support: Math.min(...found.shares) };
  }
  return { quad, refined: false, support: Math.min(...given.shares) };
}
