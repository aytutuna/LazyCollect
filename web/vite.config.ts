import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".");
  if (mode === "production" && !env.VITE_TURNSTILE_SITEKEY) {
    throw new Error("VITE_TURNSTILE_SITEKEY is not set");
  }
  // the Rust scanner's WebAssembly is built apart (scan-wasm/), so a build has it only when asked to
  const rust = env.VITE_RUST_SCANNER ? "rust-engine.ts" : "rust-engine-off.ts";
  return {
    resolve: { alias: { "#rust-engine": fileURLToPath(new URL(`./src/scan/${rust}`, import.meta.url)) } },
    worker: { format: "es" },
    build: {
      rollupOptions: { input: { main: "index.html", c: "c.html" } },
    },
    server: {
      proxy: { "/api": { target: "http://localhost:8787", headers: { origin: "http://localhost:8787" } } },
    },
  };
});
