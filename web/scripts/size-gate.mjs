// Fails when what the Rust scanner makes a client download (its WebAssembly, its JavaScript and its corner model, gzipped) is
// more than the onnxruntime-web scanner's WebAssembly and int8 model, which is what the page downloads today. Run it after
// `VITE_RUST_SCANNER=1 npm run build`, which carries both.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

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
const rust = wasm + glue + tract;
const today = ort + int8;
console.log(`Rust scanner: ${kb(wasm)} wasm + ${kb(glue)} js + ${kb(tract)} model = ${kb(rust)} gzipped`);
console.log(`onnxruntime-web scanner: ${kb(ort)} wasm + ${kb(int8)} model = ${kb(today)} gzipped`);
if (rust > today) {
  console.error("the Rust scanner downloads more than the onnxruntime-web scanner");
  process.exit(1);
}
