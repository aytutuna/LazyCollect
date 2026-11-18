import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: { input: { main: "index.html", c: "c.html" } },
  },
  server: {
    proxy: { "/api": { target: "http://localhost:8787", headers: { origin: "http://localhost:8787" } } },
  },
});
