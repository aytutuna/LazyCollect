// Fails when the Rust scanner's WebAssembly and its JavaScript outgrow their budget, gzipped. Run it after
// `VITE_RUST_SCANNER=1 npm run build`. It also prints what the onnxruntime-web scanner costs today and the two models, for comparison.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// measured 2026-11-26 on LazyKit 61484693: 2.78 MB of WebAssembly and 3 kB of JavaScript, with about 7 % to spare
const BUDGET = 3_000_000;

const web = fileURLToPath(new URL("..", import.meta.url));
const assets = readdirSync(`${web}dist/assets`);
const gz = (file) => gzipSync(readFileSync(file), { level: 9 }).length;
const find = (pattern) => {
  const names = assets.filter((a) => pattern.test(a));
  if (names.length !== 1) throw new Error(`expected one asset matching ${pattern}, found ${names.length}; was the build made with VITE_RUST_SCANNER=1?`);
  return `${web}dist/assets/${names[0]}`;
};

const wasm = gz(find(/^collect_scan_wasm_bg-.*\.wasm$/));
const glue = gz(find(/^rust\.worker-.*\.js$/));
const ort = gz(find(/^ort-wasm-simd-threaded-.*\.wasm$/));
const modelOf = (dir, name) => gz(`${web}dist/models/${dir}/${name}`);
const models = JSON.parse(readFileSync(`${web}src/scan/model.json`, "utf8"));
const int8 = modelOf(models.sha256.slice(0, 12), "docaligner-int8.onnx");
const tract = modelOf(models.tractSha256.slice(0, 12), "docaligner-tract.onnx");

const kb = (n) => `${(n / 1000).toFixed(0)} kB`;
console.log(`Rust scanner: ${kb(wasm)} wasm + ${kb(glue)} js = ${kb(wasm + glue)} gzipped, budget ${kb(BUDGET)}, plus the tract model ${kb(tract)}`);
console.log(`onnxruntime-web scanner: ${kb(ort)} wasm gzipped, plus the int8 model ${kb(int8)}`);
if (wasm + glue > BUDGET) {
  console.error("the Rust scanner is over its size budget");
  process.exit(1);
}
