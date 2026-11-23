import { homography, type Pixels, type Quad } from "./geometry";

// Synthetic pages for the tests: a white sheet of short dark strokes in lines, laid onto a brown table through a
// homography so the photo's corners are known exactly.
export function textPage(width: number, height: number, seed = 7): Pixels {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 80; y < height - 80; y += 34) {
    for (let x = 80; x < width - 120; ) {
      // a letter is a stem or two and a bar, strokes 2 px thick as at 10 pt on a 200 dpi page
      const w = 8 + Math.floor(rnd() * 8);
      const mark = (x0: number, y0: number, mw: number, mh: number) => {
        for (let j = 0; j < mh; j++) {
          for (let i = 0; i < mw; i++) {
            const o = ((y + y0 + j) * width + x + x0 + i) * 4;
            data[o] = data[o + 1] = data[o + 2] = 30;
          }
        }
      };
      mark(0, 0, 2, 16);
      mark(w - 2, 0, 2, 16);
      mark(0, rnd() < 0.5 ? 0 : 7, w, 2);
      x += w + 4 + Math.floor(rnd() * 6);
    }
  }
  return { width, height, data };
}

export function photoOf(page: Pixels, quad: Quad, width: number, height: number): Pixels {
  const h = homography(quad, [[0, 0], [page.width, 0], [page.width, page.height], [0, page.height]])!;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const w = h[6] * (x + 0.5) + h[7] * (y + 0.5) + 1;
      const u = (h[0] * (x + 0.5) + h[1] * (y + 0.5) + h[2]) / w;
      const v = (h[3] * (x + 0.5) + h[4] * (y + 0.5) + h[5]) / w;
      const inside = u >= 0 && v >= 0 && u < page.width && v < page.height;
      const p = inside ? (Math.floor(v) * page.width + Math.floor(u)) * 4 : -1;
      data[o] = p >= 0 ? page.data[p] : 120;
      data[o + 1] = p >= 0 ? page.data[p + 1] : 90;
      data[o + 2] = p >= 0 ? page.data[p + 2] : 60;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

// a box blur of radius r, one direction at a time
export function boxBlur(img: Pixels, r: number): Pixels {
  const { width, height } = img;
  let from = img.data;
  for (const horizontal of [true, false]) {
    const to = new Uint8ClampedArray(from.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let d = -r; d <= r; d++) {
          const xx = horizontal ? Math.min(Math.max(x + d, 0), width - 1) : x;
          const yy = horizontal ? y : Math.min(Math.max(y + d, 0), height - 1);
          sum += from[(yy * width + xx) * 4];
        }
        const o = (y * width + x) * 4;
        to[o] = to[o + 1] = to[o + 2] = sum / (2 * r + 1);
        to[o + 3] = 255;
      }
    }
    from = to;
  }
  return { width, height, data: from };
}

// the page with every colour value mapped through `f`
export function mapPixels(img: Pixels, f: (v: number, x: number, y: number) => number): Pixels {
  const data = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const p = i / 4;
    for (let c = 0; c < 3; c++) data[i + c] = f(img.data[i + c], p % img.width, Math.floor(p / img.width));
    data[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}
