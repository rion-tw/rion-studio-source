import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Tauri and Rust production architecture boundaries", () => {
  it("has no legacy desktop-shell source roots", async () => {
    for (const path of [
      "src/main",
      "src/preload",
      "crates/rion-node",
      "native/macos/runtime-tabs",
      "native/windows/webview2"
    ]) {
      await expect(access(path)).rejects.toBeDefined();
    }
  });

  it("links the authoritative Rust core directly into the Tauri shell", async () => {
    const [manifest, shell, runtime] = await Promise.all([
      readFile("src-tauri/Cargo.toml", "utf8"),
      readFile("src-tauri/src/lib.rs", "utf8"),
      readFile("src-tauri/src/system_runtime.rs", "utf8")
    ]);

    expect(manifest).toContain('rion-core = { path = "../crates/rion-core" }');
    expect(shell).toContain("AppCore::create");
    expect(shell).toContain("rion_core_invoke");
    expect(runtime).toContain("SystemRuntimeExecutor");
    for (const source of [manifest, shell, runtime]) {
      expect(source.toLowerCase()).not.toContain("electron");
      expect(source).not.toContain("Node-API");
    }
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
    const [entry, bridge] = await Promise.all([
      readFile("src/renderer/src/main.tsx", "utf8"),
      readFile("src/renderer/src/tauri/installTauriBridge.ts", "utf8")
    ]);

    expect(entry.indexOf("await installTauriBridgeIfNeeded()"))
      .toBeLessThan(entry.indexOf("ReactDOM.createRoot"));
    expect(bridge).toContain("const api: RionStudioApi");
    expect(bridge).toContain('invoke<CoreCommandResult<C>>("rion_core_invoke"');
    expect(bridge).not.toContain("window.__TAURI_INTERNALS__.postMessage");
  });
});
