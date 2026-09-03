import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

const electron = vi.hoisted(() => ({
  getGPUFeatureStatus: vi.fn(() => ({ webgl: "enabled" })),
  getGPUInfo: vi.fn(async () => ({ devices: [] })),
  getLocale: vi.fn(() => "zh-TW"),
  getVersion: vi.fn(() => "23.4.5"),
  showSaveDialog: vi.fn()
}));

vi.mock("electron", () => ({
  app: {
    getGPUFeatureStatus: electron.getGPUFeatureStatus,
    getGPUInfo: electron.getGPUInfo,
    getLocale: electron.getLocale,
    getVersion: electron.getVersion,
    isPackaged: true
  },
  dialog: { showSaveDialog: electron.showSaveDialog }
}));

vi.mock("node:os", () => ({ release: () => "Darwin 25.6.0" }));

import { createElectronDiagnosticsComposition } from
  "../src/electron/main/electronDiagnosticsComposition";
import type { RendererIdentity } from
  "../src/electron/main/rendererIdentity";
import type { CoreCommand } from "../src/shared/generated";

const identity: RendererIdentity = {
  kind: "main-renderer",
  windowId: 11,
  webContentsId: 17,
  generation: 3
};
const exportPath = resolve("Rion-Studio-Diagnostics.zip");
const originalChromeVersion = Object.getOwnPropertyDescriptor(
  process.versions,
  "chrome"
);
const originalElectronVersion = Object.getOwnPropertyDescriptor(
  process.versions,
  "electron"
);

beforeAll(() => {
  Object.defineProperties(process.versions, {
    chrome: { configurable: true, value: "150.0.7339.12" },
    electron: { configurable: true, value: "43.4.1" }
  });
});

afterAll(() => {
  if (originalChromeVersion) {
    Object.defineProperty(process.versions, "chrome", originalChromeVersion);
  } else {
    Reflect.deleteProperty(process.versions, "chrome");
  }
  if (originalElectronVersion) {
    Object.defineProperty(process.versions, "electron", originalElectronVersion);
  } else {
    Reflect.deleteProperty(process.versions, "electron");
  }
});

function harness() {
  const window = {
    id: identity.windowId,
    isDestroyed: () => false,
    webContents: {
      id: identity.webContentsId,
      isDestroyed: () => false
    }
  };
  const invoke = vi.fn(async (command: CoreCommand) => ({
    filePath: command.type === "diagnosticsExport" ? command.path : "",
    logFileCount: 2
  }));
  const resolveMainWindow = vi.fn(() => window);
  const diagnostics = createElectronDiagnosticsComposition({
    applicationName: "Rion Studio",
    applicationLifecycle: () => ({ phase: "running" }) as never,
    captureDisplayTopology: () => ({
      revision: 9,
      capturedAt: "2026-08-31T01:02:03.000Z",
      cause: "electron-initial",
      primaryDisplayId: "41",
      displays: [{
        id: 41,
        label: "Built-in Display",
        bounds: { x: 0, y: 0, width: 1512, height: 982 },
        workArea: { x: 0, y: 24, width: 1512, height: 958 },
        resolution: { width: 3024, height: 1964 },
        scaleFactor: 2,
        isPrimary: true,
        isInternal: true
      }]
    }),
    core: { invoke: invoke as never },
    projectCoherentSnapshot: vi.fn(() => ({})) as never,
    readCoreSnapshot: async () => ({}) as never,
    readNativeSnapshot: () => ({
      windows: [],
      tabs: [],
      roles: [],
      webSurfaces: []
    }),
    registration: () => ({
      contractVersion: 23,
      platform: "macos",
      engine: "chromium",
      adapterVersion: "appkit-4+electron-43+chromium-140",
      available: true,
      capabilities: {}
    }) as never,
    resolveMainWindow: resolveMainWindow as never
  });
  return { diagnostics, invoke, resolveMainWindow, window };
}

describe("Electron diagnostics composition", () => {
  it("keeps the exact main window as native save-dialog owner", async () => {
    electron.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: exportPath
    });
    const state = harness();

    await expect(state.diagnostics.export(identity)).resolves.toEqual({
      filePath: exportPath,
      logFileCount: 2
    });

    expect(electron.showSaveDialog).toHaveBeenCalledWith(state.window, {
      title: "Export Rion Studio Diagnostics",
      defaultPath: "Rion-Studio-Diagnostics.zip",
      filters: [{ name: "ZIP archive", extensions: ["zip"] }]
    });
    expect(state.resolveMainWindow).toHaveBeenCalledTimes(3);
    expect(state.invoke).toHaveBeenCalledWith(expect.objectContaining({
      type: "diagnosticsExport",
      path: exportPath,
      snapshot: expect.objectContaining({
        applicationName: "Rion Studio",
        applicationVersion: "23.4.5",
        locale: "zh-TW",
        packaged: true,
        systemVersion: "Darwin 25.6.0"
      })
    }));
  });

  it("does not invoke Core after native cancellation", async () => {
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    const state = harness();

    await expect(state.diagnostics.export(identity)).resolves.toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it("fails closed when a non-cancelled dialog omits its path", async () => {
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: false });
    const state = harness();

    await expect(state.diagnostics.export(identity)).rejects.toMatchObject({
      code: "ELECTRON_DIALOG_RESULT_INVALID"
    });
    expect(state.invoke).not.toHaveBeenCalled();
  });
});
