import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Tauri Stable shell", () => {
  it("uses the GUI subsystem only for Windows release builds", async () => {
    const entrypoint = await readFile("src-tauri/src/main.rs", "utf8");

    expect(entrypoint).toContain(
      '#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]'
    );
  });

  it("owns the stable application identity and shared renderer build", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
    const macConfig = JSON.parse(await readFile("src-tauri/tauri.macos.conf.json", "utf8"));

    expect(config.productName).toBe("Rion Studio");
    expect(config.identifier).toBe("com.rionstudio.launcher");
    expect(config.app.windows[0].title).toBe("Rion Studio");
    expect(macConfig.app.windows[0].title).toBe("");
    expect(config.build).toMatchObject({
      frontendDist: "../out/renderer",
      beforeDevCommand: "pnpm run dev:renderer",
      beforeBuildCommand: "pnpm run build:renderer"
    });
    expect(config.app.windows[0]).toMatchObject({
      label: "main",
      title: "Rion Studio",
      minWidth: 960,
      minHeight: 640,
      visible: false
    });
    expect(config.bundle.windows.nsis).toMatchObject({
      installMode: "currentUser",
      installerHooks: "./windows/installer-hooks.nsh"
    });
  });

  it("grants window dragging only to the local main window", async () => {
    const [capabilitySource, runtimeCapabilitySource, roleCapabilitySource] = await Promise.all([
      readFile("src-tauri/capabilities/main.json", "utf8"),
      readFile("src-tauri/capabilities/runtime-native-shell.json", "utf8"),
      readFile("src-tauri/capabilities/system-role-overlay.json", "utf8")
    ]);
    const capability = JSON.parse(capabilitySource);
    const runtimeCapability = JSON.parse(runtimeCapabilitySource);
    const roleCapability = JSON.parse(roleCapabilitySource);

    expect(capability).toMatchObject({
      identifier: "main-local-only",
      windows: ["main"]
    });
    expect(capability.permissions).toContain("core:window:allow-start-dragging");
    expect(capability).not.toHaveProperty("remote");
    expect(runtimeCapability.permissions).not.toContain("core:window:allow-start-dragging");
    expect(roleCapability.permissions).not.toContain("core:window:allow-start-dragging");
  });

  it("reuses the stable shared data directory and application lock", async () => {
    const [shell, core] = await Promise.all([
      readFile("src-tauri/src/lib.rs", "utf8"),
      readFile("crates/rion-core/src/app.rs", "utf8")
    ]);
    expect(shell).toContain('const SHARED_DATA_DIRECTORY_NAME: &str = "Rion Studio"');
    expect(core).toContain('const INSTANCE_LOCK_FILE_NAME: &str = "rion-studio.instance.lock"');
  });

  it("removes only legacy installation-directory residue during an in-place upgrade", async () => {
    const hooks = await readFile("src-tauri/windows/installer-hooks.nsh", "utf8");
    expect(hooks).toContain("NSIS_HOOK_PREINSTALL");
    expect(hooks).toContain("NSIS_HOOK_POSTINSTALL");
    expect(hooks).toContain("$INSTDIR\\resources\\app.asar");
    expect(hooks).toContain("${If} ${FileExists}");
    expect(hooks).toContain("$INSTDIR\\Uninstall Rion Studio.exe");
    expect(hooks).toContain("$INSTDIR\\resources\\native\\rion-webview2.node");
    expect(hooks).toContain("after its running-app");
    expect(hooks).toContain("--updated, --force-run");
    expect(hooks).toContain('${GetOptions} $R0 "--force-run"');
    expect(hooks).toContain("$INSTDIR\\rion-tauri.exe");
    expect(hooks).not.toContain("$APPDATA");
    expect(hooks).not.toContain("rion-studio.sqlite3");
    expect(hooks).not.toContain("roles\\");
    expect(hooks).not.toContain("taskkill");
  });

  it("keeps failed updater installation attempts in an error state", async () => {
    const manager = await readFile("src-tauri/src/update_manager.rs", "utf8");
    const install = manager.slice(
      manager.indexOf("pub fn install_downloaded"),
      manager.indexOf("pub fn open_release_page")
    );
    expect(install).toContain("if let Err(error) = update");
    expect(install).toContain("self.set_status(self.error_status(&message))");
    expect(install.indexOf("self.set_status(self.error_status(&message))"))
      .toBeLessThan(install.indexOf("*pending = None;"));
  });
});
