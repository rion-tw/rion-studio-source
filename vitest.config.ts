import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    css: {
      include: /src\/main\/macros\/overlay\/macroOverlay\.css/
    }
  }
});
