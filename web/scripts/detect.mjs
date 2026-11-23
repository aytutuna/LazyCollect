// Runs the page finder in Chrome on the fixture photos and compares its corners with the known ones, timing each run.
// Needs the model (scripts/fetch_docaligner.sh); without it there is nothing to check and the script says so.
// CHROME_PATH points at a Chrome or Edge when it is not in the usual place.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(`${root}/public/models/fastvit_t8_h_e_bifpn_256_fp32.onnx`)) {
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
    const { fromCorners } = await import("/src/scan/geometry.ts");
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
      if (found) {
        const got = fromCorners(found.quad.map((p) => [p[0] * img.naturalWidth, p[1] * img.naturalHeight]));
        worst = Math.max(...got.map((p, i) => Math.hypot(p[0] - expected[i][0], p[1] - expected[i][1])));
      }
      times.sort((a, b) => a - b);
      out.runs.push({ file: f.file, found: Boolean(found), confidence: found?.confidence ?? null, accepted: found ? acceptable(found, frame.width, frame.height) : false, worst, median: times[6], first: times[0] });
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
  const bad = !r.found || !r.accepted || r.worst > 25;
  if (bad) failures++;
  console.log(`${bad ? "FAIL" : "ok  "} ${r.file}: confidence ${r.confidence?.toFixed(2)}, worst corner off by ${r.worst?.toFixed(1)} px of 1280, inference median ${r.median.toFixed(0)} ms`);
}
await browser.close();
await server.close();
process.exit(failures ? 1 : 0);
