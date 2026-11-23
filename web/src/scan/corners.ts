import { aspect, fromCorners, isConvex, signedArea, usable, type Pixels, type Point, type Quad } from "./geometry";

// DocAligner's FastViT-T8 page corner model (Apache-2.0), read as Lazy Scan reads it: the photo stretched to 256 x 256 and
// given as blue, green and red planes of 0 to 1; the answer is four heatmaps, one per corner (top left, top right,
// bottom right, bottom left).
export const SIDE = 256;
const THRESHOLD = 0.3;
// a page is taken from this confidence (the weakest corner's peak) up, and trusted from SURE up
export const MIN_CONFIDENCE = 0.5;
export const SURE_CONFIDENCE = 0.7;

export type Found = { quad: Quad; confidence: number };

// bilinear with the pixel centres matched, as OpenCV's linear resize does it
function tap(index: number, scale: number, size: number): [number, number, number] {
  const at = Math.max((index + 0.5) * scale - 0.5, 0);
  const low = Math.min(Math.floor(at), size - 1);
  return [low, Math.min(low + 1, size - 1), at - low];
}

export function modelInput(photo: Pixels): Float32Array {
  const plane = SIDE * SIDE;
  const input = new Float32Array(3 * plane);
  const sx = photo.width / SIDE;
  const sy = photo.height / SIDE;
  const px = photo.data;
  for (let y = 0; y < SIDE; y++) {
    const [r0, r1, wy] = tap(y, sy, photo.height);
    const top = r0 * photo.width;
    const bottom = r1 * photo.width;
    for (let x = 0; x < SIDE; x++) {
      const [c0, c1, wx] = tap(x, sx, photo.width);
      for (let ch = 0; ch < 3; ch++) {
        // blue first: the model reads OpenCV's BGR
        const o = 2 - ch;
        const a = px[(top + c0) * 4 + o];
        const b = px[(top + c1) * 4 + o];
        const c = px[(bottom + c0) * 4 + o];
        const d = px[(bottom + c1) * 4 + o];
        const upper = a + (b - a) * wx;
        const lower = c + (d - c) * wx;
        input[ch * plane + y * SIDE + x] = (upper + (lower - upper) * wy) / 255;
      }
    }
  }
  return input;
}

// the heat-weighted centre of the largest 8-connected blob of values from THRESHOLD up in one channel, as shares of the
// map, and the channel's peak
function corner(heat: Float32Array, base: number, width: number, height: number): { point: Point; peak: number } | null {
  const plane = width * height;
  const seen = new Uint8Array(plane);
  const stack: number[] = [];
  let peak = 0;
  let bestCount = 0;
  let bestX = 0;
  let bestY = 0;
  for (let start = 0; start < plane; start++) {
    const value = heat[base + start];
    peak = Math.max(peak, value);
    if (value < THRESHOLD || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    let count = 0;
    let sum = 0;
    let sumX = 0;
    let sumY = 0;
    while (stack.length) {
      const at = stack.pop()!;
      const x = at % width;
      const y = (at - x) / width;
      const weight = heat[base + at];
      count++;
      sum += weight;
      sumX += weight * (x + 0.5);
      sumY += weight * (y + 0.5);
      for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, height - 1); ny++) {
        for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, width - 1); nx++) {
          const next = ny * width + nx;
          if (!seen[next] && heat[base + next] >= THRESHOLD) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    if (count > bestCount) {
      bestCount = count;
      bestX = sumX / sum;
      bestY = sumY / sum;
    }
  }
  return bestCount ? { point: [bestX / width, bestY / height], peak } : null;
}

// The page's corners as shares of the photo (x right, y down) and the confidence; null when a channel has no value from
// the threshold up or the four corners are not a convex outline in their order.
export function decodeHeatmap(heat: Float32Array, width: number, height: number): Found | null {
  const plane = width * height;
  if (width <= 0 || height <= 0 || heat.length < plane * 4) return null;
  const points: Point[] = [];
  let confidence = 1;
  for (let ch = 0; ch < 4; ch++) {
    const found = corner(heat, ch * plane, width, height);
    if (!found) return null;
    points.push(found.point);
    confidence = Math.min(confidence, found.peak);
  }
  const quad = points as Quad;
  return isConvex(quad) ? { quad, confidence } : null;
}

// The sanity checks on a page of `width` x `height` pixels: a confidence from MIN_CONFIDENCE up, corners the editor can
// cut along, covering at least a tenth of the photo and no more than 4 to 1 once the perspective is undone (Lazy Scan's
// document kind stops at 2; receipts here run longer).
export function acceptable(found: Found, width: number, height: number): boolean {
  if (!(found.confidence >= MIN_CONFIDENCE)) return false;
  const q = found.quad.map((p) => [p[0] * width, p[1] * height] as Point) as Quad;
  if (!usable(q)) return false;
  const share = signedArea(q) / (width * height);
  if (share < 0.1 || share > 1) return false;
  const wide = aspect(fromCorners(q), width, height);
  const longOverShort = Math.max(wide, 1 / wide);
  return longOverShort <= 4;
}
