import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ELECTRON_RENDERER_DOCUMENTS,
  FORBIDDEN_ELECTRON_RENDERER_MARKERS,
  TAURI_COMPATIBILITY_RENDERER_DOCUMENTS,
  verifyElectronRendererBundle
} from "../scripts/verifyElectronRendererBundle.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron renderer purity", () => {
  it("uses a shell-specific entry while retaining the Tauri compatibility entry", async () => {
    const [
      bootstrap,
      electronEntry,
      electronVite,
      rendererDocument,
      tauriEntry,
      tauriVite
    ] = await Promise.all([
      readFile("src/renderer/src/app/bootstrapRenderer.tsx", "utf8"),
      readFile("src/renderer/src/electron.tsx", "utf8"),
      readFile("electron.vite.config.ts", "utf8"),
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/src/main.tsx", "utf8"),
      readFile("vite.tauri.config.ts", "utf8")
    ]);

    expect(rendererDocument).toContain('src="/src/main.tsx"');
    expect(tauriEntry).toContain("installTauriBridgeIfNeeded");
    expect(tauriEntry).toContain("@wdio/tauri-plugin");
    expect(electronVite).toContain('src="/src/electron.tsx"');
    expect(electronVite).toContain("electronRendererEntryPlugin()");
    expect(electronEntry).toContain("window.rionStudio");
    expect(bootstrap).not.toContain("@tauri-apps/api");
    expect(bootstrap).not.toContain("__TAURI_INTERNALS__");
    for (const marker of FORBIDDEN_ELECTRON_RENDERER_MARKERS) {
      expect(electronEntry).not.toContain(marker);
    }
    for (const document of TAURI_COMPATIBILITY_RENDERER_DOCUMENTS) {
      expect(electronVite).not.toContain(`src/renderer/${document}`);
      expect(tauriVite).toContain(`src/renderer/${document}`);
    }
    for (const document of ELECTRON_RENDERER_DOCUMENTS) {
      expect(electronVite).toContain(`src/renderer/${document}`);
    }
  });

  it("keeps Workspace Web chrome local, scriptless, and preload-to-shared only", async () => {
    const [document, preload, contract, vite] = await Promise.all([
      readFile("src/renderer/runtime-web-chrome-electron.html", "utf8"),
      readFile("src/electron/preload/workspaceWebChrome.ts", "utf8"),
      readFile("src/shared/workspaceWebChrome.ts", "utf8"),
      readFile("electron.vite.config.ts", "utf8")
    ]);

    expect(document).toContain("data-rion-workspace-web-chrome");
    expect(document).toContain("script-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).not.toContain("<script");
    expect(preload).toContain('from "../../shared/workspaceWebChrome"');
    expect(preload).not.toContain("../main/");
    expect(preload).not.toContain("node:");
    expect(contract).not.toContain("electron");
    expect(contract).not.toContain("node:");
    expect(vite).toContain("runtime-web-chrome-electron.html");
    expect(vite).toContain("workspaceWebChrome.ts");
  });

  it("verifies final output and fails closed on Tauri code or documents", async () => {
    const rendererRoot = await mkdtemp(join(tmpdir(), "rion-electron-renderer-"));
    temporaryDirectories.push(rendererRoot);
    const assets = join(rendererRoot, "assets");
    await mkdir(assets);
    const mainBundle = join(assets, "main.js");
    await Promise.all([
      writeFile(join(rendererRoot, "index.html"), "<!doctype html><main></main>"),
      writeFile(
        join(rendererRoot, "runtime-windows-host.html"),
        "<!doctype html><main></main>"
      ),
      writeFile(
        join(rendererRoot, "runtime-web-chrome-electron.html"),
        "<!doctype html><nav data-rion-workspace-web-chrome></nav>"
      ),
      writeFile(
        join(rendererRoot, "runtime-role-placeholder-electron.html"),
        "<!doctype html><main data-rion-runtime-role-placeholder></main>"
      ),
      writeFile(mainBundle, "window.rionStudio.notifyRendererReady();")
    ]);

    await expect(verifyElectronRendererBundle(rendererRoot)).resolves.toMatchObject({
      rendererRoot,
      sourceCount: 5
    });

    const rolePlaceholder = join(
      rendererRoot,
      "runtime-role-placeholder-electron.html"
    );
    await rm(rolePlaceholder);
    await expect(verifyElectronRendererBundle(rendererRoot))
      .rejects.toThrow(
        "missing required document: runtime-role-placeholder-electron.html"
      );
    await writeFile(
      rolePlaceholder,
      "<!doctype html><main data-rion-runtime-role-placeholder></main>"
    );

    await writeFile(mainBundle, "globalThis.__TAURI_INTERNALS__.invoke();");
    await expect(verifyElectronRendererBundle(rendererRoot))
      .rejects.toThrow("forbidden Tauri marker");

    await Promise.all([
      writeFile(mainBundle, "window.rionStudio.notifyRendererReady();"),
      writeFile(
        join(rendererRoot, "runtime-tabs.html"),
        "<!doctype html><main></main>"
      )
    ]);
    await expect(verifyElectronRendererBundle(rendererRoot))
      .rejects.toThrow("Tauri compatibility document");
  });
});
