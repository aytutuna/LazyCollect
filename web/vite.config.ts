import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: { input: { main: "index.html", c: "c.html" } },
  },
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
});
