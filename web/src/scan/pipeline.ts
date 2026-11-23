import { applyFilter, type Filter } from "./filters";
import { aspect, edge, rotate, warp, type Pixels, type Quad } from "./geometry";
import { refine, trusted } from "./refine";

// The photo a page is cut from is kept at no more than this on its long side
export const SOURCE_MAX = 3200;
const PREVIEW = 900;
// A page is written at its own size in the photo, but not below this (readable) or above this (upload size)
const MIN_OUT = 1600;
const MAX_OUT = 2400;

// a JPEG of the photo, which is all that is kept of it between steps
export type Shot = { blob: Blob; width: number; height: number };

const canvasOf = (width: number, height: number) => Object.assign(document.createElement("canvas"), { width, height });

// iOS Safari caps the memory canvases hold, so each one is emptied as soon as its pixels or blob are taken
export const release = (canvas: HTMLCanvasElement) => {
  canvas.width = canvas.height = 0;
};

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error("encode"))), "image/jpeg", quality));

export function toCanvas(img: Pixels): HTMLCanvasElement {
  const canvas = canvasOf(img.width, img.height);
  canvas.getContext("2d")!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return canvas;
}

// `source` drawn to at most `max` pixels on its long side, on `reuse` when given
export function draw(source: CanvasImageSource, width: number, height: number, max: number, reuse?: HTMLCanvasElement): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const k = Math.min(1, max / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  const canvas = reuse ?? canvasOf(w, h);
  if (reuse && (reuse.width !== w || reuse.height !== h)) Object.assign(reuse, { width: w, height: h });
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

export function readPixels(source: CanvasImageSource, width: number, height: number, max: number, reuse?: HTMLCanvasElement): Pixels {
  const { canvas, ctx } = draw(source, width, height, max, reuse);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (!reuse) release(canvas);
  return { width: img.width, height: img.height, data: img.data };
}

export async function shotOf(source: CanvasImageSource, width: number, height: number): Promise<Shot> {
  const { canvas } = draw(source, width, height, SOURCE_MAX);
  const { width: w, height: h } = canvas;
  try {
    return { blob: await toBlob(canvas, 0.92), width: w, height: h };
  } finally {
    release(canvas);
  }
}

async function decode(shot: Shot): Promise<Pixels> {
  const bitmap = await createImageBitmap(shot.blob);
  try {
    return readPixels(bitmap, bitmap.width, bitmap.height, SOURCE_MAX);
  } finally {
    bitmap.close();
  }
}

// the model's corners moved onto the page's edges in the photo (Lazy Scan's QuadRefiner), or as they were when edges back them too little
export async function refinedQuad(shot: Shot, quad: Quad): Promise<Quad> {
  try {
    return trusted(refine(await decode(shot), quad), quad);
  } catch {
    return quad;
  }
}

// width and height of the flat page with `long` pixels on its long side, in the sheet's own proportions
function pageSize(quad: Quad, shot: Shot, long: number): [number, number] {
  const ratio = aspect(quad, shot.width, shot.height);
  return ratio >= 1 ? [long, Math.max(1, Math.round(long / ratio))] : [Math.max(1, Math.round(long * ratio)), long];
}

// the page cut out of the photo, flat and unfiltered, small enough to filter quickly while the person looks at it
export async function flatPreview(shot: Shot, quad: Quad, turns: number): Promise<Pixels | null> {
  const [w, h] = pageSize(quad, shot, PREVIEW);
  const flat = warp(await decode(shot), quad, w, h);
  return flat && rotate(flat, turns);
}

// the page as it is uploaded
export async function finalPage(shot: Shot, quad: Quad, turns: number, filter: Filter): Promise<Blob> {
  const own = Math.max(edge(quad, 0), edge(quad, 1), edge(quad, 2), edge(quad, 3));
  const [w, h] = pageSize(quad, shot, Math.min(MAX_OUT, Math.max(MIN_OUT, Math.round(own))));
  const flat = warp(await decode(shot), quad, w, h);
  if (!flat) throw new Error("warp");
  const canvas = toCanvas(applyFilter(rotate(flat, turns), filter));
  try {
    return await toBlob(canvas, 0.85);
  } finally {
    release(canvas);
  }
}

// a corner rectangle `inset` in from the photo's edges, for a photo where no page was found
export const startQuad = (width: number, height: number, inset = 0.1): Quad => [
  [width * inset, height * inset],
  [width * (1 - inset), height * inset],
  [width * (1 - inset), height * (1 - inset)],
  [width * inset, height * (1 - inset)],
];

export const pause = () => new Promise<void>((done) => setTimeout(done));
