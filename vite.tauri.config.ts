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
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "src/renderer/index.html"),
        runtimeDivider: resolve(import.meta.dirname, "src/renderer/runtime-divider.html"),
        runtimeRolePlaceholder: resolve(import.meta.dirname, "src/renderer/runtime-role-placeholder.html"),
        runtimeTabs: resolve(import.meta.dirname, "src/renderer/runtime-tabs.html")
      },
      output: {
        codeSplitting: {
          groups: [{ test: /node_modules/, name: "vendor" }]
        }
      }
    },
    sourcemap: false
  },
  resolve: {
    alias: {
      "@renderer": resolve(import.meta.dirname, "src/renderer/src"),
      "@shared": resolve(import.meta.dirname, "src/shared")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
