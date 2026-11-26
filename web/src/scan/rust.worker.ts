import wasm from "./wasm/collect_scan_wasm_bg.wasm?url";
import type { Found } from "./corners";
import type { Filter } from "./filters";
import type { Pixels, Quad } from "./geometry";
import type { Issue } from "./quality";
import type { Refinement } from "./refine";
import { init, openScanner } from "./rust-ops";

export type Request =
  | { type: "init"; model: string }
  | { type: "detect"; id: number; image: Pixels }
  | { type: "refine"; id: number; image: Pixels; quad: Quad }
  | { type: "warp"; id: number; image: Pixels; quad: Quad; width: number; height: number }
  | { type: "filter"; id: number; image: Pixels; filter: Filter }
  | { type: "frameIssues"; id: number; quad: Quad; confidence: number | null; width: number; height: number }
  | { type: "pageIssues"; id: number; image: Pixels };
export type Reply =
  | { type: "ready"; ok: boolean }
  | { type: "found"; id: number; found: Found | null }
  | { type: "refined"; id: number; refinement: Refinement | null; image: Pixels }
  | { type: "pixels"; id: number; image: Pixels | null }
  | { type: "issues"; id: number; issues: Issue[] };

let scanner: ReturnType<typeof openScanner>;

// The module and the model load here, in a worker, once the scanner opens. A model that is missing (the site answers its page for
// an unknown path) leaves detection off, as with the TypeScript scanner; the rest still works.
async function load(model: string) {
  try {
    const [, onnx] = await Promise.all([init({ module_or_path: wasm }), fetchModel(model)]);
    try {
      scanner = openScanner(onnx);
      post({ type: "ready", ok: onnx !== null });
    } catch {
      scanner = openScanner(null);
      post({ type: "ready", ok: false });
    }
  } catch {
    // the module itself did not load: nothing works
    post({ type: "ready", ok: false });
  }
}

async function fetchModel(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

const post = (reply: Reply, transfer: Transferable[] = []) => (postMessage as (message: unknown, transfer: Transferable[]) => void)(reply, transfer);
const buffer = (image: Pixels | null) => (image ? [image.data.buffer] : []);

onmessage = (e: MessageEvent<Request>) => {
  const m = e.data;
  if (m.type === "init") return void load(m.model);
  const s = scanner;
  if (m.type === "detect") {
    let found: Found | null = null;
    try {
      found = s.detect(m.image);
    } catch {
      // no answer for this frame
    }
    post({ type: "found", id: m.id, found });
  } else if (m.type === "refine") {
    let refinement: Refinement | null = null;
    try {
      refinement = s.refine(m.image, m.quad);
    } catch {
      // the corners stay as they were
    }
    post({ type: "refined", id: m.id, refinement, image: m.image }, [m.image.data.buffer]);
  } else if (m.type === "warp") {
    const image = s.warp(m.image, m.quad, m.width, m.height);
    post({ type: "pixels", id: m.id, image }, buffer(image));
  } else if (m.type === "filter") {
    const image = s.filter(m.image, m.filter);
    post({ type: "pixels", id: m.id, image }, buffer(image));
  } else if (m.type === "frameIssues") {
    post({ type: "issues", id: m.id, issues: s.frameIssues(m.quad, m.confidence, m.width, m.height) });
  } else {
    post({ type: "issues", id: m.id, issues: s.pageIssues(m.image) });
  }
};
