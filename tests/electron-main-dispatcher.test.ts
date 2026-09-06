import { describe, expect, it, vi } from "vitest";

import { createElectronBaselineDispatcher } from "../src/electron/main/baselineDispatcher";
import type { RendererIdentity } from "../src/electron/main/rendererIdentity";

const identity: RendererIdentity = {
  kind: "main-renderer",
  windowId: 1,
  webContentsId: 2,
  generation: 3
};

describe("Electron baseline API dispatcher", () => {
  it("executes only behavior backed by a real baseline shell action", async () => {
    const notifyRendererReady = vi.fn();
    const getAppSnapshot = vi.fn(async () => ({ marker: "snapshot" }) as never);
    const confirmApplicationQuit = vi.fn();
    const requestApplicationQuit = vi.fn();
    const requestCurrentWindowClose = vi.fn();
    const executeApplicationShortcut = vi.fn();
    const exportDiagnostics = vi.fn(async () => ({
      filePath: "/tmp/Rion-Studio-Diagnostics.zip",
      logFileCount: 2
    }));
    const startCurrentWindowDrag = vi.fn(async () => ({ marker: "drag" }) as never);
    const dispatcher = createElectronBaselineDispatcher({
      confirmApplicationQuit,
      getAppSnapshot,
      getAppVersion: () => "1.2.3",
      getApplicationLifecycleStatus: vi.fn(),
      getCurrentWindowState: vi.fn(),
      getDisplayTopology: vi.fn(),
      getEmbeddedRuntimeState: vi.fn(),
      consumePendingMacroPageRequest: vi.fn(() => ({ roleId: "role-1" })),
      executeApplicationShortcut,
      exportDiagnostics,
      exportPortableData: vi.fn(),
      minimizeCurrentWindow: vi.fn(),
      notifyRendererReady,
      openUpdateDownload: vi.fn(),
      previewChromeProfileImport: vi.fn(),
      previewPortableImport: vi.fn(),
      revealLogs: vi.fn(),
      requestApplicationQuit,
      requestCurrentWindowClose,
      startCurrentWindowDrag,
      toggleCurrentWindowMaximize: vi.fn(),
      reportRendererLog: vi.fn()
    });

    await expect(dispatcher.invoke(identity, "getAppVersion", []))
      .resolves.toBe("1.2.3");
    await expect(dispatcher.invoke(identity, "getAppSnapshot", []))
      .resolves.toEqual({ marker: "snapshot" });
    await expect(dispatcher.invoke(identity, "consumePendingMacroPageRequest", []))
      .resolves.toEqual({ roleId: "role-1" });
    await expect(dispatcher.invoke(identity, "consumePendingQuickAccessRequest", []))
      .resolves.toBeNull();
    await dispatcher.invoke(identity, "notifyRendererReady", []);
    await dispatcher.invoke(identity, "quitApplication", []);
    await dispatcher.invoke(identity, "confirmApplicationQuit", []);
    await dispatcher.invoke(identity, "requestCurrentWindowClose", []);
    await dispatcher.invoke(identity, "executeApplicationShortcut", ["zoomIn"]);
    await expect(dispatcher.invoke(identity, "exportDiagnostics", []))
      .resolves.toEqual({
        filePath: "/tmp/Rion-Studio-Diagnostics.zip",
        logFileCount: 2
      });
    await expect(dispatcher.invoke(identity, "startCurrentWindowDrag", []))
      .resolves.toEqual({ marker: "drag" });
    expect(getAppSnapshot).toHaveBeenCalledOnce();
    expect(notifyRendererReady).toHaveBeenCalledWith(identity);
    expect(requestApplicationQuit).toHaveBeenCalledOnce();
    expect(requestApplicationQuit).toHaveBeenCalledWith(identity);
    expect(confirmApplicationQuit).toHaveBeenCalledOnce();
    expect(confirmApplicationQuit).toHaveBeenCalledWith(identity);
    expect(requestCurrentWindowClose).toHaveBeenCalledOnce();
    expect(requestCurrentWindowClose).toHaveBeenCalledWith(identity);
    expect(executeApplicationShortcut).toHaveBeenCalledWith(identity, "zoomIn");
    expect(exportDiagnostics).toHaveBeenCalledWith(identity);
    expect(startCurrentWindowDrag).toHaveBeenCalledWith(identity);
  });

  it("returns a coded non-success for domain methods not migrated yet", async () => {
    const dispatcher = createElectronBaselineDispatcher({
      confirmApplicationQuit: vi.fn(),
      getAppSnapshot: vi.fn(),
      getAppVersion: () => "1.2.3",
      getApplicationLifecycleStatus: vi.fn(),
      getCurrentWindowState: vi.fn(),
      getDisplayTopology: vi.fn(),
      getEmbeddedRuntimeState: vi.fn(),
      consumePendingMacroPageRequest: vi.fn(() => null),
      executeApplicationShortcut: vi.fn(),
      exportDiagnostics: vi.fn(),
      exportPortableData: vi.fn(),
      minimizeCurrentWindow: vi.fn(),
      notifyRendererReady: vi.fn(),
      openUpdateDownload: vi.fn(),
      previewChromeProfileImport: vi.fn(),
      previewPortableImport: vi.fn(),
      revealLogs: vi.fn(),
      requestApplicationQuit: vi.fn(),
      requestCurrentWindowClose: vi.fn(),
      startCurrentWindowDrag: vi.fn(),
      toggleCurrentWindowMaximize: vi.fn(),
      reportRendererLog: vi.fn()
    });

    await expect(dispatcher.invoke(identity, "listRoles", []))
      .rejects.toMatchObject({
        code: "ELECTRON_SHELL_NOT_IMPLEMENTED",
        message: "The Electron shell method listRoles has not been migrated yet."
      });
  });
});
