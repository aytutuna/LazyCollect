import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "#rust-engine": fileURLToPath(new URL("./src/scan/rust-engine.ts", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"] },
});
