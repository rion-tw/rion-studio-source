import { access, readFile } from "node:fs/promises";
import { readSourceTree } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("desktop shell and Rust production architecture boundaries", () => {
  it("keeps the Electron Node-API adapter in its scoped crate and has no legacy roots", async () => {
    for (const path of [
      "src/main",
      "src/preload",
      "native/macos/runtime-tabs",
      "native/windows/webview2"
    ]) {
      await expect(access(path)).rejects.toBeDefined();
    }
    await expect(access("crates/rion-node/Cargo.toml")).resolves.toBeUndefined();
    await expect(access("src/electron/main/index.ts")).resolves.toBeUndefined();
    await expect(access("src/electron/preload/index.ts")).resolves.toBeUndefined();
  });

  it("links the authoritative Rust core directly into the Tauri shell", async () => {
    const [manifest, shell, runtime] = await Promise.all([
      readFile("src-tauri/Cargo.toml", "utf8"),
      readSourceTree("src-tauri/src/lib.rs", "utf8"),
      readSourceTree("src-tauri/src/system_runtime.rs", "utf8")
    ]);

    expect(manifest).toContain(
      'rion-core = { path = "../crates/rion-core", features = ["system-webview-probe"] }'
    );
    expect(shell).toContain("AppCore::create");
    expect(shell).toContain("rion_core_invoke");
    expect(runtime).toContain("SystemRuntimeExecutor");
    for (const source of [manifest, shell, runtime]) {
      expect(source.toLowerCase()).not.toContain("electron");
      expect(source).not.toContain("Node-API");
    }
  });

  it("compiles the v22 System WebView probe only into the Tauri compatibility shell", async () => {
    const [platformManifest, coreManifest, nodeManifest, tauriManifest, probe] =
      await Promise.all([
        readFile("crates/rion-platform/Cargo.toml", "utf8"),
        readFile("crates/rion-core/Cargo.toml", "utf8"),
        readFile("crates/rion-node/Cargo.toml", "utf8"),
        readFile("src-tauri/Cargo.toml", "utf8"),
        readFile("crates/rion-platform/src/system_webview.rs", "utf8")
      ]);

    expect(platformManifest).toContain('system-webview-probe = ["dep:webview2-com", "dep:windows-webview2"]');
    expect(platformManifest).toContain('webview2-com = { version = "=0.38.2", optional = true }');
    expect(coreManifest).toContain('system-webview-probe = ["rion-platform/system-webview-probe"]');
    expect(nodeManifest).toContain('rion-core = { path = "../rion-core", default-features = false }');
    expect(nodeManifest).not.toContain('features = ["system-webview-probe"]');
    expect(tauriManifest.match(/features = \["system-webview-probe"\]/gu)).toHaveLength(2);
    expect(probe).toContain('#[cfg(all(target_os = "macos", feature = "system-webview-probe"))]');
    expect(probe).toContain('#[cfg(all(windows, feature = "system-webview-probe"))]');
    expect(probe).toContain('"system-webview-probe-disabled"');
  });

  it("keeps generated domain and effect contracts independent from shell objects", async () => {
    const [command, event, effects, types] = await Promise.all([
      readFile("src/shared/generated/CoreCommand.ts", "utf8"),
      readFile("src/shared/generated/CoreEvent.ts", "utf8"),
      readFile("src/shared/generated/CoreEffectAction.ts", "utf8"),
      readFile("src/shared/types.ts", "utf8")
    ]);

    for (const contract of [command, event, effects]) {
      expect(contract).not.toContain("unknown");
      expect(contract).not.toContain("../types");
      expect(contract.toLowerCase()).not.toContain("electron");
    }
    expect(effects).not.toContain('{ "type": "createWindow"');
    expect(effects).not.toContain('{ "type": "debuggerCommand"');
    expect(types).not.toContain("export interface Game ");
    expect(types).toContain("export type CreateRoleInput = RoleCreateRequest");
  });

  it("installs the typed renderer bridge before React and exposes no transport shortcut", async () => {
    const [entry, bootstrap, bridge] = await Promise.all([
      readFile("src/renderer/src/main.tsx", "utf8"),
      readFile("src/renderer/src/app/bootstrapRenderer.tsx", "utf8"),
      readFile("src/renderer/src/tauri/installTauriBridge.ts", "utf8")
    ]);

    expect(entry.indexOf("await installTauriBridgeIfNeeded()"))
      .toBeLessThan(entry.indexOf("void bootstrapRenderer({"));
    expect(bootstrap).toContain("ReactDOM.createRoot");
    expect(bootstrap).not.toContain("@tauri-apps/api");
    expect(bridge).toContain("const api: RionStudioApi");
    expect(bridge).toContain('invoke<CoreCommandResult<C>>("rion_core_invoke"');
    expect(bridge).not.toContain("window.__TAURI_INTERNALS__.postMessage");
  });
});
