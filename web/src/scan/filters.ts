import type { Pixels } from "./geometry";

export type Filter = "original" | "enhanced" | "gray" | "bw";
export const FILTERS: Filter[] = ["original", "enhanced", "gray", "bw"];

const BLOCK = 32;

// The paper's colour in each block: the 90th percentile of each channel, so ink and shadows do not pull it down, then
// smoothed over the neighbouring blocks.
function paperColour(img: Pixels): { cols: number; rows: number; map: Float32Array } {
  const cols = Math.max(1, Math.ceil(img.width / BLOCK));
  const rows = Math.max(1, Math.ceil(img.height / BLOCK));
  const raw = new Float32Array(cols * rows * 3);
  const hist = new Uint16Array(256);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      for (let ch = 0; ch < 3; ch++) {
        hist.fill(0);
        let n = 0;
        const x1 = Math.min((bx + 1) * BLOCK, img.width);
        const y1 = Math.min((by + 1) * BLOCK, img.height);
        for (let y = by * BLOCK; y < y1; y += 2) {
          for (let x = bx * BLOCK; x < x1; x += 2) {
            hist[img.data[(y * img.width + x) * 4 + ch]]++;
            n++;
          }
        }
        let acc = 0;
        let level = 255;
        for (let v = 255; v >= 0; v--) {
          acc += hist[v];
          if (acc >= n * 0.1) {
            level = v;
            break;
          }
        }
        raw[(by * cols + bx) * 3 + ch] = level;
      }
    }
  }
  const map = new Float32Array(raw.length);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        let n = 0;
        for (let y = Math.max(by - 1, 0); y <= Math.min(by + 1, rows - 1); y++) {
          for (let x = Math.max(bx - 1, 0); x <= Math.min(bx + 1, cols - 1); x++) {
            sum += raw[(y * cols + x) * 3 + ch];
            n++;
          }
        }
        map[(by * cols + bx) * 3 + ch] = sum / n;
      }
    }
  }
  return { cols, rows, map };
}

// Divides out the paper's colour, which evens the lighting and the white balance in one step. Gain is capped so a
// photo or a dark region is not blown out. The result is levelled so the paper is white.
function enhance(img: Pixels): Pixels {
  const { cols, rows, map } = paperColour(img);
  const out = new Uint8ClampedArray(img.data.length);
  const { width, height } = img;
  const at = (bx: number, by: number, ch: number) => map[(Math.min(Math.max(by, 0), rows - 1) * cols + Math.min(Math.max(bx, 0), cols - 1)) * 3 + ch];
  for (let y = 0; y < height; y++) {
    const gy = (y + 0.5) / BLOCK - 0.5;
    const by = Math.floor(gy);
    const wy = gy - by;
    for (let x = 0; x < width; x++) {
      const gx = (x + 0.5) / BLOCK - 0.5;
      const bx = Math.floor(gx);
      const wx = gx - bx;
      const o = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = at(bx, by, ch) * (1 - wx) + at(bx + 1, by, ch) * wx;
        const bottom = at(bx, by + 1, ch) * (1 - wx) + at(bx + 1, by + 1, ch) * wx;
        const paper = Math.max(top * (1 - wy) + bottom * wy, 96);
        out[o + ch] = (img.data[o + ch] / paper) * 255 * (255 / 240);
      }
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

const luma = (d: Uint8ClampedArray, o: number) => 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];

function gray(img: Pixels): Pixels {
  const out = new Uint8ClampedArray(img.data.length);
  for (let o = 0; o < out.length; o += 4) {
    out[o] = out[o + 1] = out[o + 2] = luma(img.data, o);
    out[o + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

// Bradley's adaptive threshold on an integral image: a pixel is ink when it is 12 % darker than the mean around it.
function blackAndWhite(img: Pixels): Pixels {
  const { width, height } = img;
  const flat = gray(img);
  const sums = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += flat.data[(y * width + x) * 4];
      sums[(y + 1) * (width + 1) + x + 1] = sums[y * (width + 1) + x + 1] + row;
    }
  }
  const half = Math.max(8, Math.round(Math.max(width, height) / 32));
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(y - half, 0);
    const y1 = Math.min(y + half + 1, height);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(x - half, 0);
      const x1 = Math.min(x + half + 1, width);
      const total = sums[y1 * (width + 1) + x1] - sums[y0 * (width + 1) + x1] - sums[y1 * (width + 1) + x0] + sums[y0 * (width + 1) + x0];
      const o = (y * width + x) * 4;
      const v = flat.data[o] * (x1 - x0) * (y1 - y0) < total * 0.88 ? 0 : 255;
      flat.data[o] = flat.data[o + 1] = flat.data[o + 2] = v;
    }
  }
  return flat;
}

export function applyFilter(img: Pixels, filter: Filter): Pixels {
  if (filter === "original") return img;
  const clean = enhance(img);
  return filter === "enhanced" ? clean : filter === "gray" ? gray(clean) : blackAndWhite(clean);
}
