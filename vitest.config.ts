import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    css: {
      include: /src\/shared\/browser-overlay\/macroOverlay\.css/
    }
  }
});
