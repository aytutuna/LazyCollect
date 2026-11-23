export type Point = [number, number];
// corners clockwise on screen from the top left: top left, top right, bottom right, bottom left
export type Quad = [Point, Point, Point, Point];
export type Pixels = { width: number; height: number; data: Uint8ClampedArray };

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// positive when the corners run clockwise on screen (y down)
export function signedArea(q: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) & 3];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

// every corner turns clockwise and no three are in line
export function isConvex(q: Quad): boolean {
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) & 3];
    const c = q[(i + 2) & 3];
    if (!((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) > 0)) return false;
  }
  return true;
}

export const edge = (q: Quad, i: number) => dist(q[i & 3], q[(i + 1) & 3]);

export const scaled = (q: Quad, sx: number, sy: number): Quad => q.map((p) => [p[0] * sx, p[1] * sy] as Point) as Quad;

// Four corners in any order around the outline as a quad running clockwise from the top left: the first corner of the
// edge whose midpoint is highest (the smaller x on a tie).
export function fromCorners(corners: Point[]): Quad {
  const p = corners.slice();
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += p[i][0] * p[(i + 1) & 3][1] - p[(i + 1) & 3][0] * p[i][1];
  if (sum < 0) [p[1], p[3]] = [p[3], p[1]];
  let start = 0;
  let bestY = Infinity;
  let bestX = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) & 3];
    const my = (a[1] + b[1]) / 2;
    const mx = (a[0] + b[0]) / 2;
    if (my < bestY || (my === bestY && mx < bestX)) {
      bestY = my;
      bestX = mx;
      start = i;
    }
  }
  return [p[start], p[(start + 1) & 3], p[(start + 2) & 3], p[(start + 3) & 3]];
}

// the corners the editor can cut a page out along: convex, every edge at least `min` pixels long
export function usable(q: Quad, min = 16): boolean {
  return isConvex(q) && [0, 1, 2, 3].every((i) => edge(q, i) >= min);
}

// Solves the 8x8 system for the homography taking the points `from` to `to` (h33 = 1); null when it is singular.
export function homography(from: Quad, to: Quad): number[] | null {
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    m.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-12) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 9; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[8] / row[i]);
}

// Flattens the page inside `q` to a width x height image: output pixel centres map through the homography of the
// outline onto the photo, which is read bilinearly.
export function warp(src: Pixels, q: Quad, width: number, height: number): Pixels | null {
  const h = homography([[0, 0], [width, 0], [width, height], [0, height]], q);
  if (!h) return null;
  const out = new Uint8ClampedArray(width * height * 4);
  const { data, width: sw, height: sh } = src;
  const maxX = sw - 1;
  const maxY = sh - 1;
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const w = h[6] * px + h[7] * py + 1;
      const u = (h[0] * px + h[1] * py + h[2]) / w - 0.5;
      const v = (h[3] * px + h[4] * py + h[5]) / w - 0.5;
      const fx = Math.min(Math.max(u, 0), maxX);
      const fy = Math.min(Math.max(v, 0), maxY);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, maxX);
      const y1 = Math.min(y0 + 1, maxY);
      const wx = fx - x0;
      const wy = fy - y0;
      const a = (y0 * sw + x0) * 4;
      const b = (y0 * sw + x1) * 4;
      const c = (y1 * sw + x0) * 4;
      const d = (y1 * sw + x1) * 4;
      const o = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) {
        const top = data[a + k] + (data[b + k] - data[a + k]) * wx;
        const bottom = data[c + k] + (data[d + k] - data[c + k]) * wx;
        out[o + k] = top + (bottom - top) * wy + 0.5;
      }
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The page's width over its height as the sheet is, not as the camera sees it. With the optical centre in the middle of
// the photo, the four corners fix the focal length and then the sheet's shape (Zhang and He, whiteboard scanning).
// Falls back to the mean of opposite edges when the page is square on or the solution is degenerate.
export function aspect(q: Quad, imageWidth: number, imageHeight: number): number {
  const plain = (edge(q, 0) + edge(q, 2)) / (edge(q, 1) + edge(q, 3));
  const u0 = imageWidth / 2;
  const v0 = imageHeight / 2;
  const [m1, m2, m4, m3] = q.map((p) => [p[0] - u0, p[1] - v0, 1]);
  const k2d = dot(cross(m2, m4), m3);
  const k3d = dot(cross(m3, m4), m2);
  if (Math.abs(k2d) < 1e-9 || Math.abs(k3d) < 1e-9) return plain;
  const k2 = dot(cross(m1, m4), m3) / k2d;
  const k3 = dot(cross(m1, m4), m2) / k3d;
  if (Math.abs(k2 - 1) < 1e-3 || Math.abs(k3 - 1) < 1e-3) return plain;
  const n2 = m2.map((v, i) => k2 * v - m1[i]);
  const n3 = m3.map((v, i) => k3 * v - m1[i]);
  const f2 = -((n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]));
  if (!(f2 > 0) || !isFinite(f2)) return plain;
  // n's x and y are already relative to the centre, so the principal point terms drop out
  const f = Math.sqrt(f2);
  const len = (n: number[]) => Math.sqrt((n[0] / f) ** 2 + (n[1] / f) ** 2 + n[2] ** 2);
  const ratio = len(n2) / len(n3);
  return isFinite(ratio) && ratio > 0.2 && ratio < 5 ? ratio : plain;
}

// the image turned `turns` quarter turns clockwise
export function rotate(img: Pixels, turns: number): Pixels {
  const n = ((turns % 4) + 4) % 4;
  if (n === 0) return img;
  const { width: w, height: h } = img;
  const [ow, oh] = n === 2 ? [w, h] : [h, w];
  const out = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [ox, oy] = n === 1 ? [h - 1 - y, x] : n === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
      out.set(img.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (oy * ow + ox) * 4);
    }
  }
  return { width: ow, height: oh, data: out };
}
