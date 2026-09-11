import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Windows native tests launch PowerShell, C# compilers, and process-tree
    // fixtures. Two isolated workers keep those external processes within the
    // hosted-runner Job/memory envelope without changing test authority.
    ...(process.platform === "win32" ? { maxWorkers: 2 } : {}),
    testTimeout: 10_000,
    css: {
      include: /src\/shared\/browser-overlay\/macroOverlay\.css/
    }
  }
});
