import { defineConfig, defaultExclude } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest does not read .gitignore. Without these, a nested git worktree under
    // .claude/ is collected as a second full copy of the suite, and build outputs
    // are scanned for tests. Measured: 1040 files / 9140 tests before, 520 / 4570 after.
    exclude: [
      ...defaultExclude,
      "**/.claude/**",
      "**/out/**",
      "**/release/**",
      "**/target/**",
      "**/.desktop-e2e-artifacts/**"
    ],
    // Worker threads start faster than forked processes here. Per-file isolation
    // stays on: tests/renderer-visual-foundation.test.tsx depends on a fresh jsdom
    // global per file and fails without it.
    pool: "threads",
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
