import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 10_000,
    css: {
      include: /src\/shared\/browser-overlay\/macroOverlay\.css/
    }
  }
});
