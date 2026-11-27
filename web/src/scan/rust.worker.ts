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
  | { type: "filter"; id: number; image: Pixels; filter: Filter }
  | { type: "frameIssues"; id: number; quad: Quad; confidence: number | null; width: number; height: number }
  | { type: "pageIssues"; id: number; image: Pixels };
export type Reply =
  | { type: "module"; ok: boolean }
  | { type: "ready"; ok: boolean }
  | { type: "found"; id: number; found: Found | null }
  | { type: "refined"; id: number; refinement: Refinement | null; image: Pixels }
  | { type: "pixels"; id: number; image: Pixels | null }
  | { type: "issues"; id: number; issues: Issue[] | null };

const MODULE_TIMEOUT = 30_000;
const MODEL_TIMEOUT = 60_000;

let scanner: ReturnType<typeof openScanner> | undefined;

// The module loads first and answers as soon as it is there, so the operations that need no model can start; then the model
// loads. A model that is missing (the site answers its page for an unknown path) or too slow leaves detection off, as with the
// TypeScript scanner. A module that did not load leaves the engine to the TypeScript operations.
async function load(model: string) {
  try {
    const res = await fetch(wasm, { signal: AbortSignal.timeout(MODULE_TIMEOUT) });
    if (!res.ok) throw new Error("the module is not there");
    await init({ module_or_path: res });
    scanner = openScanner(null);
  } catch {
    post({ type: "module", ok: false });
    post({ type: "ready", ok: false });
    return;
  }
  post({ type: "module", ok: true });
  const onnx = await fetchModel(model);
  try {
    if (onnx) scanner = openScanner(onnx);
  } catch {
    // the model does not run here
    return post({ type: "ready", ok: false });
  }
  post({ type: "ready", ok: onnx !== null });
}

async function fetchModel(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(MODEL_TIMEOUT) });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

const post = (reply: Reply, transfer: Transferable[] = []) => (postMessage as (message: unknown, transfer: Transferable[]) => void)(reply, transfer);
const buffer = (image: Pixels | null) => (image ? [image.data.buffer] : []);

function answer(m: Exclude<Request, { type: "init" }>, s: NonNullable<typeof scanner>) {
  if (m.type === "detect") {
    post({ type: "found", id: m.id, found: s.detect(m.image) });
  } else if (m.type === "refine") {
    post({ type: "refined", id: m.id, refinement: s.refine(m.image, m.quad), image: m.image }, [m.image.data.buffer]);
  } else if (m.type === "filter") {
    const image = s.filter(m.image, m.filter);
    post({ type: "pixels", id: m.id, image }, buffer(image));
  } else if (m.type === "frameIssues") {
    post({ type: "issues", id: m.id, issues: s.frameIssues(m.quad, m.confidence, m.width, m.height) });
  } else {
    post({ type: "issues", id: m.id, issues: s.pageIssues(m.image) });
  }
}

// One request that fails gets its own empty answer, so it never takes the others down with it
onmessage = (e: MessageEvent<Request>) => {
  const m = e.data;
  if (m.type === "init") return void load(m.model);
  try {
    answer(m, scanner!);
  } catch {
    if (m.type === "detect") post({ type: "found", id: m.id, found: null });
    else if (m.type === "refine") post({ type: "refined", id: m.id, refinement: null, image: m.image });
    else if (m.type === "filter") post({ type: "pixels", id: m.id, image: null });
    else post({ type: "issues", id: m.id, issues: null });
  }
};
