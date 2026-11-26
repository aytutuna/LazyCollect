import init, { Scanner, clean_up, flatten, frame_problems, initSync, page_problems, refine_edges } from "./wasm/collect_scan_wasm.js";
import type { Found } from "./corners";
import type { Filter } from "./filters";
import type { Pixels, Quad } from "./geometry";
import type { Issue } from "./quality";
import type { Refinement } from "./refine";

export { init, initSync };

const bytes = (img: Pixels) => new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length);
const pixels = (out: Uint8Array, width: number, height: number): Pixels => ({ width, height, data: new Uint8ClampedArray(out.buffer as ArrayBuffer, out.byteOffset, out.length) });
const toQuad = (n: ArrayLike<number>): Quad => [[n[0], n[1]], [n[2], n[3]], [n[4], n[5]], [n[6], n[7]]];

// One frame as the live tracker reads it: state 0 no page, 1 moving, 2 steadying, 3 captured; quality 0 good, 1 blurry, 2 dark;
// placement 0 fine, 1 far, 2 cut off; the outline in shares of the frame
export type Live = { state: number; progress: number; steady: boolean; capture: boolean; quality: number; placement: number; shutter: boolean; outline: Quad | null };

// The scanner's operations on the loaded WebAssembly, which `init` or `initSync` has to have started; the worker and the tests share it.
// Without a model (null) only the operations that need none work.
export function openScanner(onnx: Uint8Array | null) {
  const scanner = onnx && new Scanner(onnx);
  return {
    detect(image: Pixels): Found | null {
      const n = scanner?.detect(bytes(image), image.width, image.height);
      return n?.length ? { quad: toQuad(n), confidence: n[8] } : null;
    },
    track(image: Pixels, t: number): Live | null {
      const n = scanner?.track(bytes(image), image.width, image.height, t);
      if (!n?.length) return null;
      return { state: n[0], progress: n[1], steady: n[2] === 1, capture: n[3] === 1, quality: n[4], placement: n[5], shutter: n[6] === 1, outline: n.length >= 15 ? toQuad(n.subarray(7)) : null };
    },
    refine(image: Pixels, quad: Quad): Refinement {
      const n = refine_edges(bytes(image), image.width, image.height, quad.flat());
      return { quad: toQuad(n), refined: n[8] === 1, support: n[9] };
    },
    warp(image: Pixels, quad: Quad, width: number, height: number): Pixels | null {
      const out = flatten(bytes(image), image.width, image.height, quad.flat(), width, height);
      return out.length ? pixels(out, width, height) : null;
    },
    filter(image: Pixels, filter: Filter): Pixels {
      return filter === "original" ? image : pixels(clean_up(bytes(image), image.width, image.height, filter), image.width, image.height);
    },
    pageIssues: (page: Pixels) => page_problems(bytes(page), page.width, page.height) as Issue[],
    frameIssues: (quad: Quad, confidence: number | null, width: number, height: number) => frame_problems(quad.flat(), confidence, width, height) as Issue[],
  };
}
