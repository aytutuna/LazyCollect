// Runs the page finder in Chrome on the fixture photos and compares its corners with the known ones, timing each run.
// Needs the model (scripts/fetch_docaligner.sh); without it there is nothing to check and the script says so.
// CHROME_PATH points at a Chrome or Edge when it is not in the usual place.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const { sha256 } = JSON.parse(readFileSync(`${root}/src/scan/model.json`, "utf8"));
if (!existsSync(`${root}/public/models/${sha256.slice(0, 12)}/docaligner-int8.onnx`)) {
  console.log("skipped: the corner model is not fetched");
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
const server = await createServer({ root, logLevel: "error", server: { port: 0 } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.route("**/api/**", (route) => route.fulfill({ status: 404, body: "{}" }));
await page.goto(`${url}c.html`);

// the dev server may reload the page once while it bundles the runtime
const run = async ({ fixtures, base }) => {
    const { Detector } = await import("/src/scan/detector.ts");
    const { readPixels } = await import("/src/scan/pipeline.ts");
    const { acceptable } = await import("/src/scan/corners.ts");
    const { fromCorners, warp, aspect } = await import("/src/scan/geometry.ts");
    const { refine, trusted } = await import("/src/scan/refine.ts");
    const { applyFilter } = await import("/src/scan/filters.ts");
    const detector = new Detector();
    const t0 = performance.now();
    const ok = await detector.ready;
    const load = performance.now() - t0;
    const out = { ok, load, runs: [] };
    for (const f of fixtures) {
      const img = new Image();
      img.src = `${base}${f.file}`;
      await img.decode();
      const frame = readPixels(img, img.naturalWidth, img.naturalHeight, 800);
      const times = [];
      let found = null;
      for (let i = 0; i < 12; i++) {
        const copy = { ...frame, data: frame.data.slice() };
        const t = performance.now();
        found = await detector.detect(copy);
        times.push(performance.now() - t);
      }
      const expected = fromCorners([f.topLeft, f.topRight, f.bottomRight, f.bottomLeft]);
      let worst = null;
      let refined = null;
      let support = null;
      let refineMs = null;
      let filterMs = null;
      if (found) {
        const got = fromCorners(found.quad.map((p) => [p[0] * img.naturalWidth, p[1] * img.naturalHeight]));
        const off = (q) => Math.max(...fromCorners(q).map((p, i) => Math.hypot(p[0] - expected[i][0], p[1] - expected[i][1])));
        worst = off(got);
        // the edge refinement on the full-size photo, and its cost on a 3200 px still (the photo drawn larger)
        const photo = readPixels(img, img.naturalWidth, img.naturalHeight, 2000);
        const r1 = refine(photo, got);
        refined = off(trusted(r1, got));
        support = r1.support;
        const big = document.createElement("canvas");
        big.width = 3200;
        big.height = 1800;
        big.getContext("2d").drawImage(img, 0, 0, 3200, 1800);
        const bigPixels = readPixels(big, 3200, 1800, 3200);
        const k = 3200 / img.naturalWidth;
        const t = performance.now();
        refine(bigPixels, got.map((p) => [p[0] * k, p[1] * k]));
        refineMs = performance.now() - t;
        // an enhanced page of 1600 px, as the review step makes it
        const r = aspect(got, img.naturalWidth, img.naturalHeight);
        const flat = warp(bigPixels, got.map((p) => [p[0] * k, p[1] * k]), r >= 1 ? 1600 : Math.round(1600 * r), r >= 1 ? Math.round(1600 / r) : 1600);
        const t2 = performance.now();
        applyFilter(flat, "enhanced");
        filterMs = performance.now() - t2;
      }
      times.sort((a, b) => a - b);
      out.runs.push({ file: f.file, found: Boolean(found), confidence: found?.confidence ?? null, accepted: found ? acceptable(found, frame.width, frame.height) : false, worst, refined, support, refineMs, filterMs, median: times[6], first: times[0] });
    }
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

console.log(`model loaded: ${results.ok} in ${results.load.toFixed(0)} ms`);
let failures = results.ok ? 0 : 1;
for (const r of results.runs) {
  const bad = !r.found || !r.accepted || r.worst > 25 || r.refined > r.worst + 1;
  if (bad) failures++;
  console.log(`${bad ? "FAIL" : "ok  "} ${r.file}: confidence ${r.confidence?.toFixed(2)}, worst corner off by ${r.worst?.toFixed(1)} px of 1280 (${r.refined?.toFixed(1)} refined at support ${r.support?.toFixed(2)}, ${r.refineMs?.toFixed(0)} ms on a 3200 px still; enhanced filter ${r.filterMs?.toFixed(0)} ms at 1600 px), inference median ${r.median.toFixed(0)} ms`);
}
await browser.close();
await server.close();
process.exit(failures ? 1 : 0);
