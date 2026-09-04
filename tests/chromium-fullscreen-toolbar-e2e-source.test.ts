import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Chromium fullscreen-toolbar exact replacement", () => {
  it("pairs the retained AppKit and Windows journeys around visible actions", async () => {
    const [spec, roleSurface, appKitUi, nativeActions, coverage] = await Promise.all([
      readFile("e2e/desktop/specs/chromium-fullscreen-toolbar.e2e.ts", "utf8"),
      readFile("e2e/desktop/support/electron-role-surface.ts", "utf8"),
      readFile("e2e/desktop/support/macos-appkit-ui.ts", "utf8"),
      readFile("e2e/desktop/support/native-application-actions.ts", "utf8"),
      readFile("docs/e2e-coverage.json", "utf8")
    ]);

    expect(spec).toContain("[journey:CHROMIUM-MACOS-APPKIT-FULLSCREEN-TOOLBAR-012]");
    expect(spec).toContain("[journey:CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012]");
    expect(spec).toContain("clickMacosFullscreenToolbarViewMenuItem");
    expect(spec).toContain("clickMacosVisibleFullscreenControl");
    expect(spec).toContain("pressVisibleMacosApplicationShortcut");
    expect(spec).toContain("submitElectronRolePageFullscreenShortcut");
    expect(spec).toContain("movePointerToWindowsRuntimeHostRevealEdge");
    expect(spec).toContain("movePointerToMacosFullscreenRevealEdge");
    expect(spec).toContain("movePointerToMacosRuntimeContent");
    expect(spec).toContain("electronDesktopE2eFullscreenToolbarRuntime");
    expect(spec).toContain(
      "electronDesktopE2eArmApplicationShortcutFullscreenExit"
    );
    expect(spec).toContain("waitForElectronDesktopE2eTerminalNativeQuit");
    expect(spec).toContain("electron-fullscreen-toolbar-observations.json");
    expect(spec).not.toContain("controlWindow(");
    expect(spec).not.toContain("runtimeUiAction(");
    expect(roleSurface).toContain('browser.action("key").down(Key.F11).up(Key.F11)');
    expect(roleSurface).toMatch(
      /movePointerToWindowsRuntimeHostRevealEdge[\s\S]*?browser\.action\("pointer"/u
    );
    expect(appKitUi).toContain('menu bar item "View"');
    expect(appKitUi).toContain("fullscreenControlScreenBounds");
    expect(appKitUi).toContain("click at {clickX, clickY}");
    expect(nativeActions).toContain('whose name is "Toggle Full Screen"');
    expect(nativeActions).toContain(
      "key code 3 using {control down, command down}"
    );
    expect(appKitUi).toMatch(
      /movePointerToMacosFullscreenRevealEdge[\s\S]*?CGEvent\(mouseEventSource: source/u
    );
    for (const id of [
      "CHROMIUM-MACOS-APPKIT-FULLSCREEN-TOOLBAR-012",
      "CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012"
    ]) {
      const entry = JSON.parse(coverage).journeys.find(
        (journey: { id: string }) => journey.id === id
      );
      expect(entry.replaces).toEqual(["GAME-WINDOWS-FULLSCREEN-TOOLBAR-012"]);
      expect(entry.phases).toEqual([
        "chromium-fullscreen-toolbar-seed",
        "chromium-fullscreen-toolbar-restart"
      ]);
    }
  });

  it("keeps macOS native chrome and confines the Windows local shell", async () => {
    const [factory, windowOptions, appKit, controller, shared, preload, document] =
      await Promise.all([
        readFile("src/electron/main/chromiumRuntimeHostFactory.ts", "utf8"),
        readFile("src/electron/main/windowsRuntimeHostWindowOptions.ts", "utf8"),
        readFile("src/electron/main/macosAppKitRuntimeHostFactory.ts", "utf8"),
        readFile("src/electron/main/windowsRuntimeHostChromeController.ts", "utf8"),
        readFile("src/shared/windowsRuntimeHost.ts", "utf8"),
        readFile("src/electron/preload/runtimeWindowsHost.ts", "utf8"),
        readFile("src/renderer/runtime-windows-host.html", "utf8")
      ]);

    expect(appKit).not.toContain("runtime-windows-host.html");
    expect(appKit).toContain("readMacosAppKitFullscreenToolbar");
    expect(windowOptions).toContain('partition: "rion-runtime-shell"');
    expect(factory).toContain("session.storagePath !== null");
    expect(windowOptions).toContain("sandbox: true");
    expect(windowOptions).toContain("contextIsolation: true");
    expect(windowOptions).toContain("nodeIntegration: false");
    expect(factory).toContain("WINDOWS_RUNTIME_HOST_COMMAND_CHANNEL");
    expect(factory).toContain("contents: native.webContents");
    expect(factory).toContain("record.contents.getURL()");
    expect(controller).toContain("#commandLane");
    expect(controller).toContain("await this.#requestWindowControl(command.type)");
    expect(controller).toContain("this.#pendingMinimize = null");
    expect(shared).toContain("projectedActiveTabId === value.activeTabId");
    expect(preload).toContain("isWindowsRuntimeHostCommand");
    expect(document).toContain('data-window-command="minimizeWindow"');
    expect(document).toContain('data-window-command="toggleMaximizeWindow"');
    expect(document).toContain('data-window-command="closeWindow"');
  });

  it("uses one Core presentation owner with supersede compensation and read-only history", async () => {
    const [core, snapshotModel, e2eEntry, effect, shortcut, bridge, inspection,
      runner, verifier] =
      await Promise.all([
        readFile("crates/rion-core/src/app/section_22_runtime_window_presentation.rs", "utf8"),
        readFile("crates/rion-core/src/model/section_04_state_game_record.rs", "utf8"),
        readFile("src/electron/e2e/index.ts", "utf8"),
        readFile("src/electron/main/chromiumRuntimeFullscreenToolbar.ts", "utf8"),
        readFile("src/electron/main/chromiumRoleQuickAccessShortcut.ts", "utf8"),
        readFile("src/electron/e2e/desktopE2eBridge.ts", "utf8"),
        readFile("src/electron/e2e/fullscreenToolbarInspection.ts", "utf8"),
        readFile("scripts/desktopE2eChromiumFullscreenToolbarEvidence.mjs", "utf8"),
        readFile("scripts/verifyElectronPackage.mjs", "utf8")
      ]);

    expect(core).toContain("runtimeWindowPresentationNativeReadbackVerified");
    expect(core).toContain("runtimeWindowPresentationCommitSupersededCompensated");
    expect(core).toContain("SystemRuntimeOperationStatus::Indeterminate");
    expect(snapshotModel).toContain("pub presentation: Option<String>");
    expect(e2eEntry).toContain("logical.presentation !== inspection.presentation");
    expect(e2eEntry).not.toContain("inspection.surfaces.length === 0");
    expect(e2eEntry).toContain("coreTabIds.length === 0");
    expect(e2eEntry).not.toContain(
      '!inspection.surfaces.some((surface) => surface.kind === "role")'
    );
    expect(effect).toContain("setRuntimeWindowPresentation");
    expect(shortcut).toContain('input.code === "F11"');
    expect(shortcut).toContain("input.event.preventDefault()");
    expect(bridge).toContain('action: "fullscreenToolbarRuntime"');
    expect(inspection).toContain("function exact(");
    expect(runner).toContain("electron-fullscreen-toolbar-observations.json");
    expect(runner).toContain("isHidden");
    expect(runner).toContain('"fullscreenControlScreenBounds" in appKit');
    expect(runner).toContain("isRevealed");
    expect(runner).toContain("isPinned");
    expect(runner).toContain("normal/hidden/revealed/hidden/pinned/hidden ordering");
    expect(verifier).toContain('"out/preload/runtimeWindowsHost.cjs"');
    expect(verifier).toContain('"out/preload/workspaceWebChrome.cjs"');
  });
});
