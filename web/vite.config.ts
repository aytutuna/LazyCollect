import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  if (mode === "production" && !loadEnv(mode, ".").VITE_TURNSTILE_SITEKEY) {
    throw new Error("VITE_TURNSTILE_SITEKEY is not set");
  }
  return {
    build: {
      rollupOptions: { input: { main: "index.html", c: "c.html" } },
    },
    server: {
      proxy: { "/api": { target: "http://localhost:8787", headers: { origin: "http://localhost:8787" } } },
    },
  };
});
