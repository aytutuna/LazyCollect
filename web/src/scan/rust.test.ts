import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web/wasm";
import jpeg from "jpeg-js";
import { beforeAll, describe, expect, it } from "vitest";
import { acceptable, decodeHeatmap, modelInput, SIDE, type Found } from "./corners";
import { applyFilter, FILTERS } from "./filters";
import { boxBlur, checksum, darkGround, mapPixels, photoOf, shadowedPage, textPage } from "./fixtures";
import { aspect, fromCorners, warp, type Pixels, type Quad } from "./geometry";
import model from "./model.json";
import { frameIssues, pageIssues } from "./quality";
import { placement, refine } from "./refine";

// The Rust scanner (scan-wasm/, LazyKit's lazy-scan as WebAssembly) against the TypeScript one and against LazyKit's pinned
// results. It needs the WebAssembly built (see .github/workflows/rust-scanner.yml) and the two models fetched
// (scripts/fetch_docaligner.sh and `tract`); without them it is skipped, unless LAZYCOLLECT_REQUIRE_RUST=1, which CI sets.
const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const wasm = path("./wasm/collect_scan_wasm_bg.wasm");
const tractModel = path(`../../public/models/${model.tractSha256.slice(0, 12)}/docaligner-tract.onnx`);
const int8Model = path(`../../public/models/${model.sha256.slice(0, 12)}/docaligner-int8.onnx`);
const present = [wasm, tractModel, int8Model].every(existsSync);
if (!present && process.env.LAZYCOLLECT_REQUIRE_RUST === "1") throw new Error("the Rust scanner or a model is not built");

type Ops = ReturnType<typeof import("./rust-ops").openScanner>;
let rust: Ops;
let session: ort.InferenceSession;

// the same frames, ground truth and tolerance as scripts/detect.mjs: every corner within 25 px of a 1280 px frame
const fixtures: { file: string; width: number; height: number; topLeft: number[]; topRight: number[]; bottomRight: number[]; bottomLeft: number[] }[] = JSON.parse(readFileSync(path("../../scripts/fixtures/corners.json"), "utf8"));
const TOLERANCE = 25;

function frameOf(file: string): Pixels {
  const img = jpeg.decode(readFileSync(path(`../../scripts/fixtures/${file}`)), { useTArray: true, formatAsRGBA: true });
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length) };
}

const worst = (a: Quad, b: Quad) => Math.max(...fromCorners(a).map((p, i) => Math.hypot(p[0] - fromCorners(b)[i][0], p[1] - fromCorners(b)[i][1])));
const pixels = (found: Found, f: Pixels) => found.quad.map((p) => [p[0] * f.width, p[1] * f.height]) as Quad;

async function tsFound(frame: Pixels): Promise<Found | null> {
  const out = await session.run({ img: new ort.Tensor("float32", modelInput(frame), [1, 3, SIDE, SIDE]) });
  const [, , height, width] = out.heatmap.dims;
  return decodeHeatmap(out.heatmap.data as Float32Array, width, height);
}

describe.skipIf(!present)("the Rust scanner", () => {
  beforeAll(async () => {
    const glue = await import("./rust-ops");
    glue.initSync({ module: readFileSync(wasm) });
    rust = glue.openScanner(new Uint8Array(readFileSync(tractModel)));
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(new Uint8Array(readFileSync(int8Model)), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  }, 120_000);

  describe("page corners", () => {
    for (const f of fixtures) {
      it(`${f.file} is found where the page is, as the TypeScript scanner finds it`, async () => {
        const frame = frameOf(f.file);
        const truth = fromCorners([f.topLeft, f.topRight, f.bottomRight, f.bottomLeft] as Quad);
        const found = rust.detect(frame)!;
        expect(found).not.toBeNull();
        expect(acceptable(found, frame.width, frame.height)).toBe(true);
        expect(worst(pixels(found, frame), truth)).toBeLessThanOrEqual(TOLERANCE);

        // the same photo through onnxruntime-web and the int8 model: a different runtime and weights, so close but not equal
        const old = (await tsFound(frame))!;
        expect(worst(pixels(found, frame), pixels(old, frame))).toBeLessThanOrEqual(3);
        expect(Math.abs(found.confidence - old.confidence)).toBeLessThanOrEqual(0.02);

        // the edge refinement is the same arithmetic in both and may only move the corners closer
        const given = pixels(found, frame);
        const mine = rust.refine(frame, given);
        const theirs = refine(frame, given);
        expect(mine.refined).toBe(theirs.refined);
        expect(Math.abs(mine.support - theirs.support)).toBeLessThanOrEqual(0.02);
        expect(worst(mine.quad, theirs.quad)).toBeLessThanOrEqual(1);
        const placed = placement(mine, given, found.confidence, frame.width, frame.height);
        expect(worst(placed.quad, truth)).toBeLessThanOrEqual(worst(given, truth) + 1);
      });
    }

    it("finds nothing on a blank wall", () => {
      const wall: Pixels = { width: 640, height: 480, data: new Uint8ClampedArray(640 * 480 * 4).fill(140) };
      const found = rust.detect(wall);
      expect(found === null || !acceptable(found, 640, 480)).toBe(true);
    });
  });

  describe("page clean-up", () => {
    const pages = JSON.parse(readFileSync(path("../../scripts/fixtures/enhancer.json"), "utf8")) as { results: { page: string; mode: string; sum: string }[] };
    const drawn: Record<string, Pixels> = { shadowed: shadowedPage(), "shadowed-plain": shadowedPage(false), "shadowed-picture": shadowedPage(false, true), "dark-ground": darkGround() };
    const filters: Record<string, (typeof FILTERS)[number]> = { auto: "enhanced", gray: "gray", bw: "bw" };

    for (const r of pages.results.filter((r) => r.page in drawn && r.mode in filters)) {
      it(`${r.page} in ${r.mode} has LazyKit's checksum`, () => {
        expect(checksum(rust.filter(drawn[r.page], filters[r.mode]))).toBe(parseInt(r.sum, 16));
      });
    }

    it("gives the bytes of the TypeScript filters on every page and filter", () => {
      for (const page of Object.values(drawn)) {
        for (const filter of FILTERS) expect(checksum(rust.filter(page, filter))).toBe(checksum(applyFilter(page, filter)));
      }
    });

    it("leaves the original alone", () => {
      const page = drawn.shadowed;
      expect(rust.filter(page, "original")).toBe(page);
    });
  });

  describe("cutting a page out", () => {
    const quad: Quad = [[300, 200], [900, 260], [960, 800], [240, 760]];

    it("flattens a photographed page back to the page", () => {
      const page = textPage(1000, 1400);
      const photo = photoOf(page, quad, 1200, 900);
      const flat = rust.warp(photo, quad, 1000, 1400)!;
      expect([flat.width, flat.height]).toEqual([1000, 1400]);
      let diff = 0;
      for (let i = 0; i < page.data.length; i += 4) diff += Math.abs(page.data[i] - flat.data[i]);
      expect(diff / (page.data.length / 4)).toBeLessThan(12);
    });

    it("cuts the same page as the TypeScript warp, give or take the resampling", () => {
      const photo = photoOf(mapPixels(textPage(1000, 1400), (v) => (v === 255 ? 215 : v)), quad, 1200, 900);
      const [w, h] = [800, Math.round(800 / aspect(quad, 1200, 900))];
      const mine = rust.warp(photo, quad, w, h)!;
      const theirs = warp(photo, quad, w, h)!;
      let diff = 0;
      for (let i = 0; i < mine.data.length; i += 4) diff += Math.abs(mine.data[i] - theirs.data[i]);
      expect(diff / (mine.data.length / 4)).toBeLessThan(12);
    });

    it("gives nothing for an outline that is not convex", () => {
      const photo = photoOf(textPage(1000, 1400), quad, 1200, 900);
      expect(rust.warp(photo, [quad[0], quad[2], quad[1], quad[3]], 100, 100)).toBeNull();
    });
  });

  describe("quality checks", () => {
    const page = mapPixels(textPage(1000, 1400), (v) => (v === 255 ? 215 : v));
    const blank: Pixels = { width: 800, height: 1000, data: new Uint8ClampedArray(800 * 1000 * 4).fill(250) };
    const cases: [string, Pixels][] = [
      ["sharp", page],
      ["soft", boxBlur(page, 1)],
      ["blurred", boxBlur(page, 12)],
      ["blank", blank],
      ["glared", mapPixels(page, (v, x, y) => (x >= 300 && x < 700 && y >= 300 && y < 700 ? 255 : v))],
      ["dark", mapPixels(page, (v) => v * 0.25)],
    ];

    for (const [name, img] of cases) {
      it(`${name} page: the same problems as the TypeScript checks`, () => {
        expect(rust.pageIssues(img)).toEqual(pageIssues(img));
      });
    }

    it("names the problems the TypeScript tests expect", () => {
      expect(rust.pageIssues(page)).toEqual([]);
      expect(rust.pageIssues(boxBlur(page, 12))).toContain("blur");
      expect(rust.pageIssues(cases[5][1])).toContain("dark");
      expect(rust.pageIssues(cases[4][1])).toContain("glare");
    });

    it("judges where the page sits in the frame as the TypeScript checks do", () => {
      const outlines: [Quad, number | null][] = [
        [[[100, 100], [700, 100], [700, 500], [100, 500]], 0.9],
        [[[0, 100], [700, 100], [700, 500], [0, 500]], 0.9],
        [[[100, 100], [700, 100], [700, 500], [100, 500]], 0.55],
        [[[300, 200], [500, 200], [500, 400], [300, 400]], null],
      ];
      for (const [q, confidence] of outlines) expect(rust.frameIssues(q, confidence, 800, 600)).toEqual(frameIssues(q, confidence, 800, 600));
      expect(rust.frameIssues(outlines[1][0], 0.9, 800, 600)).toEqual(["cut"]);
    });
  });

  describe("the live tracker", () => {
    it("follows a page held still, settles on it and says when to take it", () => {
      const f = fixtures[0];
      const frame = frameOf(f.file);
      const truth = fromCorners([f.topLeft, f.topRight, f.bottomRight, f.bottomLeft] as Quad);
      let last = null as ReturnType<Ops["track"]>;
      let took = false;
      for (let t = 0; t < 4000 && !took; t += 150) {
        last = rust.track({ ...frame, data: frame.data.slice() }, t) ?? last;
        took = Boolean(last?.capture);
      }
      expect(took).toBe(true);
      const outline = last!.outline!.map((p) => [p[0] * frame.width, p[1] * frame.height]) as Quad;
      expect(worst(outline, truth)).toBeLessThanOrEqual(TOLERANCE);
    });
  });
});
