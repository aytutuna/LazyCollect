import * as ort from "onnxruntime-web/wasm";
import wasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { decodeHeatmap, modelInput, SIDE, type Found } from "./corners";
import type { Pixels, Quad } from "./geometry";
import { refine, type Refinement } from "./refine";

export type Request = { type: "init"; model: string } | { type: "detect"; id: number; image: Pixels } | { type: "refine"; id: number; image: Pixels; quad: Quad };
export type Reply = { type: "ready"; ok: boolean } | { type: "found"; id: number; found: Found | null } | { type: "refined"; id: number; refinement: Refinement | null; image: Pixels };

let session: ort.InferenceSession | null = null;

// The runtime and the model load here, in a worker, so the page stays responsive and nothing is fetched until the
// scanner opens. A model that is missing (the site answers its page for an unknown path) just leaves detection off.
async function init(model: string) {
  try {
    ort.env.wasm.wasmPaths = { wasm };
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const res = await fetch(model);
    if (!res.ok) throw new Error(String(res.status));
    session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    post({ type: "ready", ok: true });
  } catch {
    post({ type: "ready", ok: false });
  }
}

async function detect(id: number, image: Pixels) {
  let found: Found | null = null;
  try {
    const out = await session!.run({ img: new ort.Tensor("float32", modelInput(image), [1, 3, SIDE, SIDE]) });
    const heat = out.heatmap;
    const [, , height, width] = heat.dims;
    found = decodeHeatmap(heat.data as Float32Array, width, height);
  } catch {
    // no answer for this frame
  }
  post({ type: "found", id, found });
}

// The edge refinement runs here too, off the main thread, on the very pixels the page is cut from: the buffer comes back
// with the answer so it is decoded only once.
function refineEdges(id: number, image: Pixels, quad: Quad) {
  let refinement: Refinement | null = null;
  try {
    refinement = refine(image, quad);
  } catch {
    // the corners stay as they were
  }
  post({ type: "refined", id, refinement, image }, [image.data.buffer]);
}

const post = (reply: Reply, transfer: Transferable[] = []) => (postMessage as (message: unknown, transfer: Transferable[]) => void)(reply, transfer);

onmessage = (e: MessageEvent<Request>) => {
  const m = e.data;
  if (m.type === "init") void init(m.model);
  else if (m.type === "detect") void detect(m.id, m.image);
  else refineEdges(m.id, m.image, m.quad);
};
