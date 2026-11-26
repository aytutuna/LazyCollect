import type { Found } from "./corners";
import type { Filter } from "./filters";
import type { Pixels, Quad } from "./geometry";
import type { Issue } from "./quality";
import type { Refinement } from "./refine";
import { Detector } from "./detector";
import { RustEngine } from "#rust-engine";

// What the scanner asks of whatever finds, cuts out and cleans up its pages. `Detector` does it in TypeScript with the
// onnxruntime-web model, `RustEngine` with LazyKit's Rust scanner as WebAssembly. Pixel buffers: detect, refine and warp take the
// one they are given (refine hands it back); filter and the issue checks copy.
export interface Engine {
  // whether the corner model loaded; without it detect answers null and the corners are placed by hand
  ready: Promise<boolean>;
  detect(image: Pixels): Promise<Found | null>;
  refine(image: Pixels, quad: Quad): Promise<{ refinement: Refinement | null; image: Pixels } | null>;
  warp(image: Pixels, quad: Quad, width: number, height: number): Promise<Pixels | null>;
  filter(image: Pixels, filter: Filter): Promise<Pixels>;
  frameIssues(quad: Quad, confidence: number | null, width: number, height: number): Promise<Issue[]>;
  pageIssues(page: Pixels): Promise<Issue[]>;
  close(): void;
}

const KEY = "lazycollect.scanner";

// The Rust scanner is in a build only when VITE_RUST_SCANNER is set, and a tester turns it on in such a build with ?scanner=rust
// (kept in localStorage; ?scanner=ts turns it off again). Everything else gets the TypeScript scanner.
function rustAsked(): boolean {
  if (!import.meta.env.VITE_RUST_SCANNER) return false;
  const asked = new URLSearchParams(location.search).get("scanner");
  // storage can be blocked, and then the URL decides alone
  try {
    if (asked === "rust") localStorage.setItem(KEY, "rust");
    else if (asked) localStorage.removeItem(KEY);
    return localStorage.getItem(KEY) === "rust";
  } catch {
    return asked === "rust";
  }
}

export const createEngine = (): Engine => (rustAsked() ? new RustEngine() : new Detector());
