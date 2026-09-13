import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { electronMainBundleGuard } from "./scripts/electronMainBundleGuard.mjs";
import { electronReactRefresh } from "./scripts/electronReactRefresh.mjs";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const repositoryRoot = import.meta.dirname;
// Bundle provenance includes tracked edits and new source files during development.
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const sourceDiff = execFileSync("git", ["diff", "HEAD", "--", "."], { cwd: repositoryRoot });
const newSources = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"],
  { cwd: repositoryRoot, encoding: "utf8" }).split("\0").filter(Boolean);
const sourceHash = createHash("sha256").update(sourceDiff);
for (const path of newSources.sort()) sourceHash.update(path).update(readFileSync(resolve(repositoryRoot, path)));
const buildCommit = sourceDiff.length || newSources.length
  ? `${sourceCommit}+worktree.${sourceHash.digest("hex").slice(0, 16)}` : sourceCommit;
const desktopE2eBuild = process.env.RION_STUDIO_DESKTOP_E2E_BUILD === "1";
const electronMainInput = resolve(
  repositoryRoot,
  desktopE2eBuild ? "src/electron/e2e/entry.ts" : "src/electron/main/index.ts"
);
const electronMainPreloadInput = resolve(
  repositoryRoot,
  desktopE2eBuild ? "src/electron/e2e/preload.ts" : "src/electron/preload/index.ts"
);
const rendererInput = {
  main: resolve(repositoryRoot, "src/renderer/index.html"),
  runtimeWindowsHost: resolve(repositoryRoot, "src/renderer/runtime-windows-host.html"),
  runtimeWorkspaceWebChrome: resolve(
    repositoryRoot,
    "src/renderer/runtime-web-chrome-electron.html"
  ),
  runtimeRolePlaceholder: resolve(
    repositoryRoot,
    "src/renderer/runtime-role-placeholder-electron.html"
  )
};
export default defineConfig({
  main: {
    define: { __RION_BUILD_COMMIT__: JSON.stringify(buildCommit) },
    plugins: [electronMainBundleGuard()],
    build: {
      externalizeDeps: {
        include: ["electron"]
      },
      rollupOptions: {
        external: ["electron"],
        input: { index: electronMainInput },
        ...(desktopE2eBuild
          ? { output: { codeSplitting: false, format: "es" as const } }
          : {})
      },
      sourcemap: false
    }
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external: ["electron"],
        input: {
          index: electronMainPreloadInput,
          role: resolve(repositoryRoot, "src/electron/preload/role.ts"),
          extensionCompat: resolve(
            repositoryRoot,
            "third_party/electron-chrome-extensions/src/rion-preload.ts"
          ),
          extensionStore: resolve(
            repositoryRoot,
            "src/electron/preload/extensionStore.ts"
          ),
          runtimeWindowsHost: resolve(
            repositoryRoot,
            "src/electron/preload/runtimeWindowsHost.ts"
          ),
          workspaceWebChrome: resolve(
            repositoryRoot,
            "src/electron/preload/workspaceWebChrome.ts"
          )
        },
        output: {
          entryFileNames: "[name].cjs",
          format: "cjs"
        }
      },
      sourcemap: false
    }
  },
  renderer: {
    define: {
      __RION_DESKTOP_E2E__: JSON.stringify(
        process.env.RION_STUDIO_DESKTOP_E2E_BUILD === "1"
      ),
      __RION_DESKTOP_E2E_DRIVER__: JSON.stringify(
        process.env.RION_STUDIO_DESKTOP_E2E_BUILD === "1" ? "chromium" : "none"
      )
    },
    root: "src/renderer",
    plugins: [tailwindcss(), react(), electronReactRefresh()],
    build: {
      emptyOutDir: true,
      outDir: resolve(repositoryRoot, "out/renderer"),
      rollupOptions: {
        input: rendererInput,
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
        "@renderer": resolve(repositoryRoot, "src/renderer/src"),
        "@shared": resolve(repositoryRoot, "src/shared")
      }
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true
    }
  }
});
