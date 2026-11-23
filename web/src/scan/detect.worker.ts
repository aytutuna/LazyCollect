import * as ort from "onnxruntime-web/wasm";
import wasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { decodeHeatmap, modelInput, SIDE, type Found } from "./corners";
import type { Pixels } from "./geometry";

export type Request = { type: "init"; model: string } | { type: "detect"; id: number; image: Pixels };
export type Reply = { type: "ready"; ok: boolean } | { type: "found"; id: number; found: Found | null };

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

const post = (reply: Reply) => postMessage(reply);

onmessage = (e: MessageEvent<Request>) => {
  if (e.data.type === "init") void init(e.data.model);
  else void detect(e.data.id, e.data.image);
};
