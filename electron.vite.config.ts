import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        include: ["electron"]
      },
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts")
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: {
        include: ["electron"]
      },
      rollupOptions: {
        input: {
          divider: resolve(__dirname, "src/preload/divider.ts"),
          embedded: resolve(__dirname, "src/preload/embedded.ts"),
          index: resolve(__dirname, "src/preload/index.ts")
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    root: "src/renderer",
    plugins: [tailwindcss(), react()],
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src"),
        "@shared": resolve(__dirname, "src/shared")
      }
    }
  }
});
