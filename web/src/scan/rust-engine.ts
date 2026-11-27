import model from "./model.json";
import type { Found } from "./corners";
import type { Engine } from "./engine";
import { applyFilter, type Filter } from "./filters";
import { warp, type Pixels, type Quad } from "./geometry";
import { frameIssues, pageIssues, type Issue } from "./quality";
import type { Refinement } from "./refine";
import type { Reply, Request } from "./rust.worker";

// the path carries the file's hash (scripts/fetch_docaligner.sh tract), so a new model is a new, immutable URL
const MODEL = `/models/${model.tractSha256.slice(0, 12)}/docaligner-tract.onnx`;

type Asked<T extends Reply["type"]> = Extract<Reply, { type: T }>;
type Question<R = Request> = R extends { id: number } ? Omit<R, "id"> : never;

// The WebAssembly scanner in a worker. Clean-up and the checks need only the module and use the TypeScript ones until it has
// answered or when it is not there; `ready` is the corner model, which loads after the module and only detection waits for.
// Cutting out stays the TypeScript warp: the page checks' thresholds were tuned on its resampling, and Lazy Scan's warp differs.
export class RustEngine implements Engine {
  private worker = new Worker(new URL("./rust.worker.ts", import.meta.url), { type: "module" });
  private waiting = new Map<number, (reply: Reply | null) => void>();
  private next = 0;
  private gone = false;
  private moduleOk = false;
  ready: Promise<boolean>;

  constructor() {
    let modelLoaded: (ok: boolean) => void;
    this.ready = new Promise((resolve) => (modelLoaded = resolve));
    this.worker.onmessage = (e: MessageEvent<Reply>) => {
      if (e.data.type === "module") this.moduleOk = e.data.ok;
      else if (e.data.type === "ready") modelLoaded(e.data.ok);
      else {
        this.waiting.get(e.data.id)?.(e.data);
        this.waiting.delete(e.data.id);
      }
    };
    this.worker.onerror = () => {
      this.gone = true;
      this.moduleOk = false;
      modelLoaded(false);
      this.settle();
    };
    this.worker.postMessage({ type: "init", model: MODEL } satisfies Request);
  }

  private settle() {
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
  }

  // null when the module is not there (yet) or the worker is gone; nothing is posted then, so the caller's pixels stay its own
  private async ask<T extends Reply["type"]>(type: T, request: Question, transfer: Transferable[] = []): Promise<Asked<T> | null> {
    if (!this.moduleOk || this.gone) return null;
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve as (reply: Reply | null) => void);
      this.worker.postMessage({ ...request, id }, transfer);
    });
  }

  async detect(image: Pixels): Promise<Found | null> {
    if (!(await this.ready)) return null;
    const reply = await this.ask("found", { type: "detect", image }, [image.data.buffer]);
    return reply?.found ?? null;
  }

  async refine(image: Pixels, quad: Quad): Promise<{ refinement: Refinement | null; image: Pixels } | null> {
    const reply = await this.ask("refined", { type: "refine", image, quad }, [image.data.buffer]);
    return reply && { refinement: reply.refinement, image: reply.image };
  }

  async warp(image: Pixels, quad: Quad, width: number, height: number): Promise<Pixels | null> {
    return warp(image, quad, width, height);
  }

  async filter(image: Pixels, filter: Filter): Promise<Pixels> {
    return (await this.ask("pixels", { type: "filter", image, filter }))?.image ?? applyFilter(image, filter);
  }

  async frameIssues(quad: Quad, confidence: number | null, width: number, height: number): Promise<Issue[]> {
    return (await this.ask("issues", { type: "frameIssues", quad, confidence, width, height }))?.issues ?? frameIssues(quad, confidence, width, height);
  }

  async pageIssues(page: Pixels): Promise<Issue[]> {
    return (await this.ask("issues", { type: "pageIssues", image: page }))?.issues ?? pageIssues(page);
  }

  close() {
    this.worker.terminate();
    this.settle();
  }
}
