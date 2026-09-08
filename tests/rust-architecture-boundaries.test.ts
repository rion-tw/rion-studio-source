import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("sole Electron and Rust production boundaries", () => {
  it("removes old runtime roots while retaining Core and AppKit", async () => {
    for (const path of ["src/main", "src/preload", "native/macos/runtime-tabs", "native/windows/webview2", "src-tauri/Cargo.toml", "src/renderer/src/tauri", "vite.tauri.config.ts"]) {
      await expect(access(path)).rejects.toBeDefined();
    }
    for (const path of ["crates/rion-node/Cargo.toml", "crates/rion-appkit/Cargo.toml", "src/electron/main/index.ts", "src/electron/preload/index.ts"]) {
      await expect(access(path)).resolves.toBeUndefined();
    }
  });
  it("links native Rust authority without a System WebView runtime", async () => {
    const node = await readFile("crates/rion-node/Cargo.toml", "utf8");
    expect(node).toContain('rion-core = { path = "../rion-core", default-features = false }');
    expect(node).toContain('rion-appkit = { path = "../rion-appkit" }');
    for (const path of ["Cargo.toml", "crates/rion-node/Cargo.toml", "crates/rion-core/Cargo.toml", "crates/rion-platform/Cargo.toml"]) {
      const source = await readFile(path, "utf8");
      expect(source).not.toMatch(/(?:tauri|tauri-build|wry|webview2-com)\s*=/u);
      expect(source).not.toContain("system-webview-probe");
    }
    const adapter = await readFile("crates/rion-node/src/lib.rs", "utf8");
    expect(adapter).toContain("AppCore::create");
    expect(adapter).toContain("CHROMIUM_RUNTIME_CONTRACT_VERSION");
  });
  it("keeps generated domain contracts independent from shell objects", async () => {
    for (const name of ["CoreCommand", "CoreEvent", "CoreEffectAction"]) {
      const source = await readFile(`src/shared/generated/${name}.ts`, "utf8");
      expect(source).not.toContain("unknown");
      expect(source).not.toContain("../types");
      expect(source.toLowerCase()).not.toContain("electron");
      expect(source).not.toContain('{ "type": "createWindow"');
      expect(source).not.toContain('{ "type": "debuggerCommand"');
    }
    const types = await readFile("src/shared/types.ts", "utf8");
    expect(types).not.toContain("export interface Game ");
    expect(types).toContain("export type CreateRoleInput = RoleCreateRequest");
  });
  it("requires the typed preload bridge before React without renderer transport", async () => {
    const entry = await readFile("src/renderer/src/main.tsx", "utf8");
    const preload = await readFile("src/electron/preload/index.ts", "utf8");
    expect(entry).toContain('typeof window.rionStudio !== "object"');
    expect(entry).toContain("prepare: prepareElectronRenderer");
    expect(preload).toContain("installRionStudioPreloadBridge(contextBridge, ipcRenderer)");
    for (const path of ["src/renderer/src/main.tsx", "src/renderer/src/app/bootstrapRenderer.tsx"]) {
      const source = await readFile(path, "utf8");
      expect(source).not.toContain("@tauri-apps/api");
      expect(source).not.toContain("__TAURI_INTERNALS__");
      expect(source).not.toContain("ipcRenderer");
    }
  });
});
