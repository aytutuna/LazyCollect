import type { Found } from "./corners";
import type { Pixels } from "./geometry";
import type { Reply, Request } from "./detect.worker";

const MODEL = "/models/fastvit_t8_h_e_bifpn_256_fp32.onnx";

// The page finder, running in a worker. `ready` says whether the model loaded; without it `detect` answers null and the
// scanner falls back to placing the corners by hand.
export class Detector {
  private worker = new Worker(new URL("./detect.worker.ts", import.meta.url), { type: "module" });
  private waiting = new Map<number, (found: Found | null) => void>();
  private next = 0;
  ready: Promise<boolean>;

  constructor() {
    this.ready = new Promise((resolve) => {
      this.worker.onmessage = (e: MessageEvent<Reply>) => {
        if (e.data.type === "ready") resolve(e.data.ok);
        else {
          this.waiting.get(e.data.id)?.(e.data.found);
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
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.send({ type: "detect", id, image }, [image.data.buffer]);
    });
  }

  close() {
    this.worker.terminate();
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
  }
}
