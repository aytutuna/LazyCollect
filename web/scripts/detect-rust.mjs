// Runs the Rust scanner in Chrome on the fixture photos, next to the onnxruntime-web one, and prints how far each is from the known
// corners and from the other, with the time of each step. Needs both models (scripts/fetch_docaligner.sh, with and without `tract`)
// and the WebAssembly (scan-wasm/); without them there is nothing to check and the script says so.
// CHROME_PATH points at a Chrome or Edge when it is not in the usual place.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const models = JSON.parse(readFileSync(`${root}/src/scan/model.json`, "utf8"));
const needed = [
  `${root}/public/models/${models.sha256.slice(0, 12)}/docaligner-int8.onnx`,
  `${root}/public/models/${models.tractSha256.slice(0, 12)}/docaligner-tract.onnx`,
  `${root}/src/scan/wasm/collect_scan_wasm_bg.wasm`,
];
const missing = needed.filter((p) => !existsSync(p));
if (missing.length) {
  console.log(`skipped: ${missing.join(", ")} not there`);
  process.exit(0);
}
const candidates = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const executablePath = candidates.find((p) => p && existsSync(p));
if (!executablePath) throw new Error("No Chrome found; set CHROME_PATH");

const fixtures = JSON.parse(readFileSync(`${root}/scripts/fixtures/corners.json`, "utf8"));
process.env.VITE_RUST_SCANNER = "1";
const server = await createServer({ root, logLevel: "error", server: { port: 0 } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.route("**/api/**", (route) => route.fulfill({ status: 404, body: "{}" }));
await page.goto(`${url}c.html`);

const run = async ({ fixtures, base }) => {
  const { RustEngine } = await import("/src/scan/rust-engine.ts");
  const { Detector } = await import("/src/scan/detector.ts");
  const { readPixels } = await import("/src/scan/pipeline.ts");
  const { acceptable } = await import("/src/scan/corners.ts");
  const { fromCorners, aspect } = await import("/src/scan/geometry.ts");
  const { placement } = await import("/src/scan/refine.ts");
  const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const timed = async (n, f) => {
    const times = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await f();
      times.push(performance.now() - t);
    }
    return median(times);
  };
  const t0 = performance.now();
  const rust = new RustEngine();
  const ok = await rust.ready;
  const load = performance.now() - t0;
  const t1 = performance.now();
  const old = new Detector();
  const oldOk = await old.ready;
  const oldLoad = performance.now() - t1;
  const out = { ok: ok && oldOk, load, oldLoad, runs: [] };
  for (const f of fixtures) {
    const img = new Image();
    img.src = `${base}${f.file}`;
    await img.decode();
    const frame = readPixels(img, img.naturalWidth, img.naturalHeight, 800);
    const copy = () => ({ ...frame, data: frame.data.slice() });
    const found = await rust.detect(copy());
    const before = await old.detect(copy());
    const detectMs = await timed(12, () => rust.detect(copy()));
    const oldMs = await timed(12, () => old.detect(copy()));
    const expected = fromCorners([f.topLeft, f.topRight, f.bottomRight, f.bottomLeft]);
    const px = (q) => fromCorners(q.map((p) => [p[0] * img.naturalWidth, p[1] * img.naturalHeight]));
    const off = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
    const run = { file: f.file, found: Boolean(found), accepted: found ? acceptable(found, frame.width, frame.height) : false };
    if (found && before) {
      const got = px(found.quad);
      run.confidence = found.confidence;
      run.oldConfidence = before.confidence;
      run.worst = off(got, expected);
      run.oldWorst = off(px(before.quad), expected);
      run.apart = off(got, px(before.quad));
      // the 3200 px still: edge refinement, the review page cut out and cleaned up, its checks
      const big = document.createElement("canvas");
      big.width = 3200;
      big.height = 1800;
      big.getContext("2d").drawImage(img, 0, 0, 3200, 1800);
      const still = readPixels(big, 3200, 1800, 3200);
      const k = 3200 / img.naturalWidth;
      const quad = got.map((p) => [p[0] * k, p[1] * k]);
      const copyStill = () => ({ ...still, data: still.data.slice() });
      run.refineMs = await timed(3, async () => (await rust.refine(copyStill(), quad)).image);
      run.oldRefineMs = await timed(3, async () => (await old.refine(copyStill(), quad)).image);
      const natural = readPixels(img, img.naturalWidth, img.naturalHeight, 2000);
      const refined = (await rust.refine(natural, got)).refinement;
      run.ours = off(placement(refined, got, found.confidence, img.naturalWidth, img.naturalHeight).quad, expected);
      const r = aspect(got, img.naturalWidth, img.naturalHeight);
      const [w, h] = r >= 1 ? [1600, Math.round(1600 / r)] : [Math.round(1600 * r), 1600];
      run.warpMs = await timed(3, async () => rust.warp(copyStill(), quad, w, h));
      run.oldWarpMs = await timed(3, async () => old.warp(copyStill(), quad, w, h));
      const flat = await rust.warp(copyStill(), quad, w, h);
      run.filterMs = await timed(3, () => rust.filter(flat, "enhanced"));
      run.oldFilterMs = await timed(3, () => old.filter(flat, "enhanced"));
      run.issuesMs = await timed(3, () => rust.pageIssues(flat));
      run.oldIssuesMs = await timed(3, () => old.pageIssues(flat));
    }
    out.runs.push({ ...run, detectMs, oldMs });
  }
  rust.close();
  old.close();
  return out;
};

let results;
for (let attempt = 0; !results; attempt++) {
  try {
    await page.waitForLoadState("load");
    results = await page.evaluate(run, { fixtures, base: "/scripts/fixtures/" });
  } catch (e) {
    if (attempt > 3 || !/context was destroyed/.test(e.message)) throw e;
  }
}

const ms = (v) => (v == null ? "-" : v.toFixed(0));
console.log(`models loaded: ${results.ok}; Rust scanner ready in ${results.load.toFixed(0)} ms, onnxruntime-web in ${results.oldLoad.toFixed(0)} ms`);
let failures = results.ok ? 0 : 1;
for (const r of results.runs) {
  const bad = !r.found || !r.accepted || r.worst > 25 || r.apart > 3 || r.ours > r.worst + 1;
  if (bad) failures++;
  console.log(`${bad ? "FAIL" : "ok  "} ${r.file}: Rust ${r.worst?.toFixed(1)} px off, onnxruntime-web ${r.oldWorst?.toFixed(1)} px off, ${r.apart?.toFixed(1)} px apart (confidence ${r.confidence?.toFixed(3)} and ${r.oldConfidence?.toFixed(3)}); ms Rust / onnxruntime-web: detect ${ms(r.detectMs)} / ${ms(r.oldMs)}, refine ${ms(r.refineMs)} / ${ms(r.oldRefineMs)}, cut out ${ms(r.warpMs)} / ${ms(r.oldWarpMs)}, clean up ${ms(r.filterMs)} / ${ms(r.oldFilterMs)}, checks ${ms(r.issuesMs)} / ${ms(r.oldIssuesMs)}`);
}
await browser.close();
await server.close();
process.exit(failures ? 1 : 0);
