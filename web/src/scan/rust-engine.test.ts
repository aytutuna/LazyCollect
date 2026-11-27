import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFilter } from "./filters";
import { textPage } from "./fixtures";
import { warp, type Pixels, type Quad } from "./geometry";
import { pageIssues } from "./quality";
import { RustEngine } from "./rust-engine";
import type { Reply, Request } from "./rust.worker";

// The engine against a worker that does what the test says, to see what happens when the module or the model does not load
class FakeWorker {
  static last: FakeWorker;
  onmessage: (e: { data: Reply }) => void = () => {};
  onerror: () => void = () => {};
  posted: Request[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: Request) {
    this.posted.push(m);
  }
  say(reply: Reply) {
    this.onmessage({ data: reply });
  }
}

const quad: Quad = [[20, 20], [380, 30], [370, 280], [30, 270]];
const photo = (): Pixels => ({ width: 400, height: 300, data: new Uint8ClampedArray(400 * 300 * 4).fill(180) });

beforeEach(() => vi.stubGlobal("Worker", FakeWorker));
afterEach(() => vi.unstubAllGlobals());

describe("the Rust engine", () => {
  it("cuts out in TypeScript and checks without waiting for the corner model", async () => {
    const engine = new RustEngine();
    const w = FakeWorker.last;
    w.say({ type: "module", ok: true });
    expect(await engine.warp(photo(), quad, 120, 90)).toEqual(warp(photo(), quad, 120, 90));
    expect(w.posted.map((m) => m.type)).toEqual(["init"]);
    const sheet = textPage(300, 400);
    const checked = engine.pageIssues(sheet);
    await vi.waitFor(() => expect(w.posted.map((m) => m.type)).toContain("pageIssues"));
    const asked = w.posted[1] as Extract<Request, { type: "pageIssues" }>;
    w.say({ type: "issues", id: asked.id, issues: ["dark"] });
    expect(await checked).toEqual(["dark"]);
    let settled = false;
    void engine.ready.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("does not wait for a module that has not answered", async () => {
    const engine = new RustEngine();
    const sheet = textPage(300, 400);
    expect(await engine.pageIssues(sheet)).toEqual(pageIssues(sheet));
    expect(await engine.filter(photo(), "gray")).toEqual(applyFilter(photo(), "gray"));
    expect(FakeWorker.last.posted.map((m) => m.type)).toEqual(["init"]);
  });

  it("keeps detection off but everything else on when the model does not load", async () => {
    const engine = new RustEngine();
    FakeWorker.last.say({ type: "module", ok: true });
    FakeWorker.last.say({ type: "ready", ok: false });
    expect(await engine.ready).toBe(false);
    expect(await engine.detect(photo())).toBeNull();
    expect(FakeWorker.last.posted.map((m) => m.type)).toEqual(["init"]);
  });

  describe("when the WebAssembly does not load", () => {
    it("cuts out, filters and checks in TypeScript, and posts nothing", async () => {
      const engine = new RustEngine();
      FakeWorker.last.say({ type: "module", ok: false });
      FakeWorker.last.say({ type: "ready", ok: false });
      const page = photo();
      const mine = await engine.warp(page, quad, 120, 90);
      expect(mine).toEqual(warp(photo(), quad, 120, 90));
      expect(await engine.filter(page, "gray")).toEqual(applyFilter(photo(), "gray"));
      const sheet = textPage(300, 400);
      expect(await engine.pageIssues(sheet)).toEqual(pageIssues(sheet));
      expect(await engine.frameIssues(quad, 0.9, 400, 300)).toEqual([]);
      expect(FakeWorker.last.posted.map((m) => m.type)).toEqual(["init"]);
    });

    it("does the same when the worker never starts, and answers at once afterwards", async () => {
      const engine = new RustEngine();
      FakeWorker.last.onerror();
      expect(await engine.ready).toBe(false);
      expect((await engine.warp(photo(), quad, 120, 90))?.width).toBe(120);
      expect(await engine.filter(photo(), "bw")).toEqual(applyFilter(photo(), "bw"));
      expect(FakeWorker.last.posted.map((m) => m.type)).toEqual(["init"]);
    });
  });

  it("falls back to the TypeScript checks for a request the worker could not answer, and leaves the other requests alone", async () => {
    const engine = new RustEngine();
    const w = FakeWorker.last;
    w.say({ type: "module", ok: true });
    const sheet = textPage(300, 400);
    const failing = engine.pageIssues(sheet);
    const other = engine.frameIssues(quad, 0.9, 400, 300);
    await vi.waitFor(() => expect(w.posted).toHaveLength(3));
    const [, a, b] = w.posted as Extract<Request, { id: number }>[];
    w.say({ type: "issues", id: a.id, issues: null });
    w.say({ type: "issues", id: b.id, issues: ["cut"] });
    expect(await failing).toEqual(pageIssues(sheet));
    expect(await other).toEqual(["cut"]);
  });
});
