import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  plugins: [tailwindcss(), react()],
  build: {
    emptyOutDir: true,
    outDir: "../../out/renderer",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/renderer/index.html"),
        runtimeDivider: resolve(__dirname, "src/renderer/runtime-divider.html"),
        runtimeTabs: resolve(__dirname, "src/renderer/runtime-tabs.html")
      }
    },
    sourcemap: false
  },
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer/src"),
      "@shared": resolve(__dirname, "src/shared")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
