import model from "./model.json";
import type { Found } from "./corners";
import type { Pixels, Quad } from "./geometry";
import type { Refinement } from "./refine";
import type { Reply, Request } from "./detect.worker";

// the path carries the file's hash (scripts/fetch_docaligner.sh), so a new model is a new, immutable URL
const MODEL = `/models/${model.sha256.slice(0, 12)}/docaligner-int8.onnx`;

// The page finder, running in a worker. `ready` says whether the model loaded; without it `detect` answers null and the
// scanner falls back to placing the corners by hand.
export class Detector {
  private worker = new Worker(new URL("./detect.worker.ts", import.meta.url), { type: "module" });
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
      this.worker.onerror = () => resolve(false);
    });
    this.send({ type: "init", model: MODEL });
  }

  private send(request: Request, transfer: Transferable[] = []) {
    this.worker.postMessage(request, transfer);
  }

  // the image's pixel buffer moves to the worker
  async detect(image: Pixels): Promise<Found | null> {
    if (!(await this.ready)) return null;
    const id = this.next++;
    const reply = await new Promise<Reply | null>((resolve) => {
      this.waiting.set(id, resolve);
      this.send({ type: "detect", id, image }, [image.data.buffer]);
    });
    return reply?.type === "found" ? reply.found : null;
  }

  // Moves `quad` onto the page's edges in the photo `image`. The pixel buffer goes to the worker and comes back with the
  // answer, so the caller keeps using it; null when the worker is gone (the buffer is then lost with it).
  async refine(image: Pixels, quad: Quad): Promise<{ refinement: Refinement | null; image: Pixels } | null> {
    const id = this.next++;
    const reply = await new Promise<Reply | null>((resolve) => {
      this.waiting.set(id, resolve);
      this.send({ type: "refine", id, image, quad }, [image.data.buffer]);
    });
    return reply?.type === "refined" ? { refinement: reply.refinement, image: reply.image } : null;
  }

  close() {
    this.worker.terminate();
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
  }
}
