import type { Pixels } from "./geometry";

// Lazy Scan's page clean-up (DocumentEnhancer and BackgroundMap), ported with the same constants, sampling and rounding, so
// the same page comes out the same in both. How bright the paper is everywhere is estimated in large tiles, each tile's
// paper a high percentile of its luma; tiles much darker than their neighbours (a picture) are filled in from them unless the
// dark region reaches the page's edge (a shadow); each pixel is divided by the paper there. The levels are stretched from a
// black point to a white point. Lazy Scan reads the rows in parallel bands; here they run one after another.
export type Filter = "original" | "enhanced" | "whiteboard" | "gray" | "bw";
export const FILTERS: Filter[] = ["original", "enhanced", "whiteboard", "gray", "bw"];

type Mode = "auto" | "color" | "gray" | "bw" | "whiteboard";

const TILES_ALONG_LONG_SIDE = 16;
const MIN_TILE = 8;
const BACKGROUND_PERCENTILE = 0.9;
const DARK_TILE_SHARE = 0.7;
const MIN_BACKGROUND_SHARE = 0.4;
const MIN_BACKGROUND = 32;
const PAPER_SHARE = 0.9;
const MIN_GAIN = 0.87;
const MAX_GAIN = 1.15;
const WHITE_POINT = 0.9;
const BLACK_PERCENTILE = 0.005;
const BILEVEL_SHARE = 0.78;
const DEFAULT_THRESHOLD = 0.5;
const MAX_BLACK_POINT = 0.5;
const LEVELS = 1024;
const SAMPLE_STEP = 2;
const PHOTO_CLIP = 0.005;
const MIN_PHOTO_RANGE = 64;
const GROUND_PERCENTILE = 0.5;
const LIGHT_CONTRAST = 1.5;
const MIN_LIGHT_SHARE = 0.005;
const WHITEBOARD_SATURATION = 1.5;
// ColorAnalysis: a page is gray when fewer than this share of every 4th pixel has chroma above 32
const COLOR_STEP = 4;
const CHROMA_THRESHOLD = 32;
const MAX_COLORED = 0.001;

export type Gray = { width: number; height: number; data: Uint8Array };

export function luma(img: Pixels): Gray {
  const n = img.width * img.height;
  const data = new Uint8Array(n);
  const d = img.data;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    data[p] = Math.min(255, Math.floor((299 * d[i] + 587 * d[i + 1] + 114 * d[i + 2] + 500) / 1000));
  }
  return { width: img.width, height: img.height, data };
}

// the smallest value with at least ceil(fraction x count) values at or below it
export function percentile(histogram: ArrayLike<number>, count: number, fraction: number): number {
  const rank = Math.min(Math.max(Math.ceil(fraction * count), 1), Math.max(1, count));
  let seen = 0;
  for (let v = 0; v < histogram.length; v++) {
    seen += histogram[v];
    if (seen >= rank) return v;
  }
  return histogram.length - 1;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// for each of `length` pixels split into `tiles` equal tiles: the tiles whose centres surround the pixel's centre and the second's weight
function interpolation(length: number, tiles: number) {
  const first = new Int32Array(length);
  const second = new Int32Array(length);
  const weight = new Float64Array(length);
  const centres = new Float64Array(tiles);
  for (let t = 0; t < tiles; t++) centres[t] = (Math.floor((t * length) / tiles) + Math.floor(((t + 1) * length) / tiles)) / 2;
  let k = 0;
  for (let p = 0; p < length; p++) {
    const c = p + 0.5;
    while (k < tiles - 1 && centres[k + 1] <= c) k++;
    if (c <= centres[0]) {
      first[p] = 0;
      second[p] = 0;
    } else if (k >= tiles - 1) {
      first[p] = tiles - 1;
      second[p] = tiles - 1;
    } else {
      first[p] = k;
      second[p] = k + 1;
      weight[p] = (c - centres[k]) / (centres[k + 1] - centres[k]);
    }
  }
  return { first, second, weight };
}

// How bright the paper is across a page: a high percentile of each tile, interpolated between tile centres.
export class BackgroundMap {
  private across: ReturnType<typeof interpolation>;
  private down: ReturnType<typeof interpolation>;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly columns: number,
    readonly rows: number,
    readonly tiles: Uint8Array,
  ) {
    this.across = interpolation(width, columns);
    this.down = interpolation(height, rows);
  }

  static estimate(gray: Gray, tileSize: number, fraction: number): BackgroundMap | null {
    const { width: w, height: h } = gray;
    if (w <= 0 || h <= 0) return null;
    const size = Math.max(1, tileSize);
    const columns = Math.max(1, Math.floor(w / size));
    const rows = Math.max(1, Math.floor(h / size));
    const tiles = new Uint8Array(columns * rows);
    const histogram = new Int32Array(256);
    for (let ty = 0; ty < rows; ty++) {
      const top = Math.floor((ty * h) / rows);
      const bottom = Math.floor(((ty + 1) * h) / rows);
      for (let tx = 0; tx < columns; tx++) {
        const left = Math.floor((tx * w) / columns);
        const right = Math.floor(((tx + 1) * w) / columns);
        histogram.fill(0);
        for (let py = top; py < bottom; py++) for (let px = left; px < right; px++) histogram[gray.data[py * w + px]]++;
        tiles[ty * columns + tx] = percentile(histogram, (bottom - top) * (right - left), fraction);
      }
    }
    return new BackgroundMap(w, h, columns, rows, tiles);
  }

  private with(tiles: Uint8Array) {
    return new BackgroundMap(this.width, this.height, this.columns, this.rows, tiles);
  }

  medianTile(): number {
    return Array.from(this.tiles).sort((a, b) => a - b)[Math.floor(this.tiles.length / 2)];
  }

  // each tile replaced by the brightest (or darkest) of itself and its eight neighbours
  private neighbours(pick: (a: number, b: number) => number, start: number): BackgroundMap {
    const out = new Uint8Array(this.tiles.length);
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.columns; tx++) {
        let best = start;
        for (let ny = Math.max(0, ty - 1); ny <= Math.min(this.rows - 1, ty + 1); ny++)
          for (let nx = Math.max(0, tx - 1); nx <= Math.min(this.columns - 1, tx + 1); nx++) best = pick(best, this.tiles[ny * this.columns + nx]);
        out[ty * this.columns + tx] = best;
      }
    }
    return this.with(out);
  }

  maxSmoothed = () => this.neighbours(Math.max, 0);
  minSmoothed = () => this.neighbours(Math.min, 255);

  // Tiles much darker than the paper beside them are filled in from it, pass after pass; a filled region that reaches the
  // map's outer tiles is lighting (a shadow cast across the sheet) and takes its own values back.
  raisedDarkTiles(share: number): BackgroundMap {
    const { columns, rows, tiles } = this;
    let current = Uint8Array.from(tiles);
    let next = new Uint8Array(tiles.length);
    const passes = Math.max(columns, rows);
    for (let pass = 0; pass < passes; pass++) {
      let changed = false;
      for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < columns; tx++) {
          let best = 0;
          for (let ny = Math.max(0, ty - 1); ny <= Math.min(rows - 1, ty + 1); ny++) {
            for (let nx = Math.max(0, tx - 1); nx <= Math.min(columns - 1, tx + 1); nx++) {
              if (nx === tx && ny === ty) continue;
              best = Math.max(best, current[ny * columns + nx]);
            }
          }
          const value = current[ty * columns + tx];
          if (value < share * best) {
            next[ty * columns + tx] = best;
            changed = true;
          } else next[ty * columns + tx] = value;
        }
      }
      [current, next] = [next, current];
      if (!changed) break;
    }
    const visited = new Uint8Array(current.length);
    const members = new Int32Array(current.length);
    for (let start = 0; start < current.length; start++) {
      if (visited[start] || current[start] === tiles[start]) continue;
      visited[start] = 1;
      members[0] = start;
      let count = 1;
      let reachesEdge = false;
      for (let k = 0; k < count; k++) {
        const tile = members[k];
        const tx = tile % columns;
        const ty = Math.floor(tile / columns);
        if (tx === 0 || ty === 0 || tx === columns - 1 || ty === rows - 1) reachesEdge = true;
        for (let ny = Math.max(0, ty - 1); ny <= Math.min(rows - 1, ty + 1); ny++) {
          for (let nx = Math.max(0, tx - 1); nx <= Math.min(columns - 1, tx + 1); nx++) {
            const n = ny * columns + nx;
            if (visited[n] || current[n] === tiles[n]) continue;
            visited[n] = 1;
            members[count++] = n;
          }
        }
      }
      if (reachesEdge) for (let m = 0; m < count; m++) current[members[m]] = tiles[members[m]];
    }
    return this.with(current);
  }

  clampedBelow(floor: number): BackgroundMap {
    return this.with(this.tiles.map((v) => Math.max(v, floor)));
  }

  // bilinear between the centres of the surrounding tiles, the nearest tile's value beyond the outer centres
  valueAt(px: number, py: number): number {
    const ax = Math.min(Math.max(px, 0), this.width - 1);
    const ay = Math.min(Math.max(py, 0), this.height - 1);
    const { first: x0, second: x1, weight: fx } = this.across;
    const { first: y0, second: y1, weight: fy } = this.down;
    const c = this.columns;
    const top = lerp(this.tiles[y0[ay] * c + x0[ax]], this.tiles[y0[ay] * c + x1[ax]], fx[ax]);
    const bottom = lerp(this.tiles[y1[ay] * c + x0[ax]], this.tiles[y1[ay] * c + x1[ax]], fx[ax]);
    return top + (bottom - top) * fy[ay];
  }
}

const tileSize = (w: number, h: number) => Math.max(MIN_TILE, Math.floor(Math.max(w, h) / TILES_ALONG_LONG_SIDE));

function paperMap(gray: Gray): BackgroundMap | null {
  const raw = BackgroundMap.estimate(gray, tileSize(gray.width, gray.height), BACKGROUND_PERCENTILE);
  if (!raw) return null;
  const filled = raw.raisedDarkTiles(DARK_TILE_SHARE);
  const floor = Math.max(MIN_BACKGROUND, Math.floor(filled.medianTile() * MIN_BACKGROUND_SHARE));
  return filled.clampedBelow(Math.min(255, floor));
}

// Light print on a dark ground (a chalkboard, a slide): no division by the paper can make its ground white.
export function isLightOnDark(gray: Gray): boolean {
  const { width: w, height: h } = gray;
  const ground = BackgroundMap.estimate(gray, tileSize(w, h), GROUND_PERCENTILE);
  if (!ground) return false;
  const highest = ground.maxSmoothed();
  const lowest = ground.minSmoothed();
  let light = 0;
  let dark = 0;
  let samples = 0;
  for (let y = 0; y < h; y += SAMPLE_STEP) {
    for (let x = 0; x < w; x += SAMPLE_STEP) {
      const l = gray.data[y * w + x];
      const above = Math.max(highest.valueAt(x, y), MIN_BACKGROUND);
      const below = Math.max(lowest.valueAt(x, y), MIN_BACKGROUND);
      if (l >= above * LIGHT_CONTRAST) light++;
      else if (l * LIGHT_CONTRAST <= below) dark++;
      samples++;
    }
  }
  return light > dark && light >= MIN_LIGHT_SHARE * samples;
}

const gain = (l: number, channel: number) => Math.min(Math.max(l / channel, MIN_GAIN), MAX_GAIN);

// the paper's white balance: over the sampled pixels at least PAPER_SHARE of the paper there, each channel's gain is the luma's sum over its own
function whiteBalance(img: Pixels, gray: Gray, paper: BackgroundMap): [number, number, number] {
  const { width: w, height: h } = img;
  let r = 0;
  let g = 0;
  let b = 0;
  let l = 0;
  for (let y = 0; y < h; y += SAMPLE_STEP) {
    for (let x = 0; x < w; x += SAMPLE_STEP) {
      const p = y * w + x;
      const lum = gray.data[p];
      if (lum >= paper.valueAt(x, y) * PAPER_SHARE) {
        r += img.data[p * 4];
        g += img.data[p * 4 + 1];
        b += img.data[p * 4 + 2];
        l += lum;
      }
    }
  }
  if (!l || !r || !g || !b) return [1, 1, 1];
  return [gain(l, r), gain(l, g), gain(l, b)];
}

// a value against the paper's background, as a level 0..LEVELS (at most the paper's own)
const level = (value: number, background: number) => Math.floor(Math.min(1, value / background) * LEVELS + 0.5);

function blackPoint(gray: Gray, paper: BackgroundMap): number {
  const histogram = new Int32Array(LEVELS + 1);
  let samples = 0;
  for (let y = 0; y < gray.height; y += SAMPLE_STEP) {
    for (let x = 0; x < gray.width; x += SAMPLE_STEP) {
      histogram[level(gray.data[y * gray.width + x], paper.valueAt(x, y))]++;
      samples++;
    }
  }
  return Math.min(percentile(histogram, samples, BLACK_PERCENTILE) / LEVELS, MAX_BLACK_POINT);
}

// the levels 0..LEVELS stretched linearly from lo (black) to hi (white)
function stretch(lo: number, hi: number): Uint8Array {
  const lut = new Uint8Array(LEVELS + 1);
  for (let k = 0; k <= LEVELS; k++) lut[k] = Math.floor(Math.min(Math.max((k / LEVELS - lo) / (hi - lo), 0), 1) * 255 + 0.5);
  return lut;
}

const saturated = (value: number, around: number) => Math.min(Math.max(around + Math.floor((value - around) * WHITEBOARD_SATURATION + 0.5), 0), 255);

// the levels stretched as a whole, the same for each channel, from the 0.5 % and 99.5 % percentiles of luma to 0 and 255
function stretched(img: Pixels): Pixels {
  const gray = luma(img);
  const histogram = new Int32Array(256);
  for (const v of gray.data) histogram[v]++;
  const count = img.width * img.height;
  const lo = percentile(histogram, count, PHOTO_CLIP);
  const hi = percentile(histogram, count, 1 - PHOTO_CLIP);
  if (hi - lo < MIN_PHOTO_RANGE) return img;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.min(Math.max(Math.floor(((i - lo) * 255) / (hi - lo) + 0.5), 0), 255);
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = lut[img.data[i]];
    out[i + 1] = lut[img.data[i + 1]];
    out[i + 2] = lut[img.data[i + 2]];
    out[i + 3] = img.data[i + 3];
  }
  return { width: img.width, height: img.height, data: out };
}

function isEffectivelyGray(data: Uint8ClampedArray, w: number, h: number): boolean {
  let samples = 0;
  let colored = 0;
  for (let y = 0; y < h; y += COLOR_STEP) {
    for (let x = 0; x < w; x += COLOR_STEP) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      samples++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > CHROMA_THRESHOLD) colored++;
    }
  }
  return samples > 0 && colored < MAX_COLORED * samples;
}

// A light on dark page in `mode`: stretched as a whole, then gray or thresholded at the setting of 255.
function lightOnDark(img: Pixels, mode: Mode): Pixels {
  const page = stretched(img);
  if (mode === "color" || mode === "whiteboard") return page;
  const { width: w, height: h } = page;
  if (mode === "auto" && !isEffectivelyGray(page.data, w, h)) return page;
  const lumas = luma(page).data;
  const threshold = Math.floor(DEFAULT_THRESHOLD * 255 + 0.5);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const v = mode === "bw" ? (lumas[p] < threshold ? 0 : 255) : lumas[p];
    out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = v;
    out[p * 4 + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

function enhance(img: Pixels, mode: Mode): Pixels {
  const { width: w, height: h } = img;
  const gray = luma(img);
  if (isLightOnDark(gray)) return lightOnDark(img, mode);
  const paper = paperMap(gray);
  if (!paper) return img;
  const black = mode === "whiteboard" ? 0 : blackPoint(gray, paper);
  const lut = stretch(black, WHITE_POINT);
  const colour = mode === "auto" || mode === "color" || mode === "whiteboard";
  const balance = colour ? whiteBalance(img, gray, paper) : ([1, 1, 1] as const);
  const blackBelow = Math.floor(BILEVEL_SHARE * LEVELS + 0.5);
  const src = img.data;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const i = p * 4;
      const background = paper.valueAt(x, y);
      if (colour) {
        out[i] = lut[level(src[i] * balance[0], background)];
        out[i + 1] = lut[level(src[i + 1] * balance[1], background)];
        out[i + 2] = lut[level(src[i + 2] * balance[2], background)];
        if (mode === "whiteboard") {
          const l = Math.floor((299 * out[i] + 587 * out[i + 1] + 114 * out[i + 2] + 500) / 1000);
          out[i] = saturated(out[i], l);
          out[i + 1] = saturated(out[i + 1], l);
          out[i + 2] = saturated(out[i + 2], l);
        }
      } else {
        const share = level(gray.data[p], background);
        const v = mode === "bw" ? (share < blackBelow ? 0 : 255) : lut[share];
        out[i] = out[i + 1] = out[i + 2] = v;
      }
      out[i + 3] = 255;
    }
  }
  // auto: a page with no colour left is stored gray, as the gray mode makes it
  if (mode === "auto" && isEffectivelyGray(out, w, h)) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = lut[level(gray.data[p], paper.valueAt(x, y))];
      }
    }
  }
  return { width: w, height: h, data: out };
}

const MODES: Record<Exclude<Filter, "original">, Mode> = { enhanced: "auto", whiteboard: "whiteboard", gray: "gray", bw: "bw" };

export function applyFilter(img: Pixels, filter: Filter): Pixels {
  return filter === "original" ? img : enhance(img, MODES[filter]);
}
