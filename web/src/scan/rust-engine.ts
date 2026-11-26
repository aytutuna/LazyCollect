import model from "./model.json";
import type { Found } from "./corners";
import type { Engine } from "./engine";
import type { Filter } from "./filters";
import type { Pixels, Quad } from "./geometry";
import type { Issue } from "./quality";
import type { Refinement } from "./refine";
import type { Reply, Request } from "./rust.worker";

// the path carries the file's hash (scripts/fetch_docaligner.sh tract), so a new model is a new, immutable URL
const MODEL = `/models/${model.tractSha256.slice(0, 12)}/docaligner-tract.onnx`;

type Asked<T extends Reply["type"]> = Extract<Reply, { type: T }>;
type Question<R = Request> = R extends { id: number } ? Omit<R, "id"> : never;

export class RustEngine implements Engine {
  private worker = new Worker(new URL("./rust.worker.ts", import.meta.url), { type: "module" });
  private waiting = new Map<number, (reply: Reply | null) => void>();
  private next = 0;
  ready: Promise<boolean>;

  constructor() {
    this.ready = new Promise((resolve) => {
      this.worker.onmessage = (e: MessageEvent<Reply>) => {
        if (e.data.type === "ready") resolve(e.data.ok);
        else {
          this.waiting.get(e.data.id)?.(e.data);
          this.waiting.delete(e.data.id);
        }
      };
      this.worker.onerror = () => {
        resolve(false);
        this.settle();
      };
    });
    this.worker.postMessage({ type: "init", model: MODEL } satisfies Request);
  }

  private settle() {
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
  }

  // null when the worker is gone
  private async ask<T extends Reply["type"]>(type: T, request: Question, transfer: Transferable[] = []): Promise<Asked<T> | null> {
    await this.ready;
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
    const reply = await this.ask("pixels", { type: "warp", image, quad, width, height }, [image.data.buffer]);
    return reply?.image ?? null;
  }

  async filter(image: Pixels, filter: Filter): Promise<Pixels> {
    const reply = await this.ask("pixels", { type: "filter", image, filter });
    if (!reply?.image) throw new Error("filter");
    return reply.image;
  }

  async frameIssues(quad: Quad, confidence: number | null, width: number, height: number): Promise<Issue[]> {
    return (await this.ask("issues", { type: "frameIssues", quad, confidence, width, height }))?.issues ?? [];
  }

  async pageIssues(page: Pixels): Promise<Issue[]> {
    return (await this.ask("issues", { type: "pageIssues", image: page }))?.issues ?? [];
  }

  close() {
    this.worker.terminate();
    this.settle();
  }
}
