import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "extension"),
  publicDir: resolve(import.meta.dirname, "extension/public"),
  worker: { format: "es" },
  build: {
    outDir: resolve(import.meta.dirname, "../dist/extension"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, "extension/popup.html"),
        options: resolve(import.meta.dirname, "extension/options.html"),
        widget: resolve(import.meta.dirname, "extension/widget.html"),
        standalone: resolve(import.meta.dirname, "extension/standalone.html"),
        offscreen: resolve(import.meta.dirname, "extension/offscreen.html"),
        serviceWorker: resolve(import.meta.dirname, "extension/src/service-worker.js"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
