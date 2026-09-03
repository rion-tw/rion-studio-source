import { describe, expect, it, vi } from "vitest";

import { ElectronDiagnosticsExport } from
  "../src/electron/main/electronDiagnosticsExport";
import type { RendererIdentity } from "../src/electron/main/rendererIdentity";
import type {
  BrowserPerformanceDiagnosticsRecord,
  CoreCommand,
  DisplayTopologySnapshotRecord,
  SystemRuntimeDiagnosticsRecord
} from "../src/shared/generated";

const identity: RendererIdentity = {
  kind: "main-renderer",
  windowId: 11,
  webContentsId: 17,
  generation: 3
};

function nativeRuntime(): SystemRuntimeDiagnosticsRecord {
  return {
    contractVersion: 23,
    platform: "macos",
    shutdownState: "accepting",
    healthy: true,
    snapshotComplete: true,
    collectionErrorCodes: [],
    nativeCreationLimit: 8,
    activeInputFences: [],
    recentInputFenceEvents: [],
    recentMacroStartAttempts: [],
    recentFailures: [],
    recentOperations: [],
    capabilityEvidence: [],
    recentRuntimeKernelOperations: []
  };
}

function displayTopology(): DisplayTopologySnapshotRecord {
  return {
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
  };
}

function browserPerformance(): BrowserPerformanceDiagnosticsRecord {
  return {
    capturedAt: "2026-08-31T01:02:04.000Z",
    platform: "macos",
    status: "available",
    windowFocused: true,
    highRefreshRateRequested: true,
    sampleDurationMs: 1_000,
    surfaces: []
  };
}

function harness() {
  const window = {
    id: identity.windowId,
    destroyed: false,
    webContents: {
      id: identity.webContentsId,
      isDestroyed: () => window.destroyed
    },
    isDestroyed: () => window.destroyed
  };
  const resolveMainWindow = vi.fn(() => window);
  const showNativeSaveDialog = vi.fn(async (): Promise<string | null> =>
    "/tmp/Rion-Studio-Diagnostics.zip");
  const captureApplication = vi.fn(() => ({
    applicationName: "Rion Studio",
    applicationVersion: "23.4.5",
    buildCommit: "abc123",
    packaged: true,
    locale: "zh-TW",
    systemVersion: "macOS 15.6"
  }));
  const captureRuntimeVersions = vi.fn(() => ({
    chromiumVersion: "150.0.7339.12",
    electronVersion: "43.4.1"
  }));
  const captureDisplayTopology = vi.fn(displayTopology);
  const captureGpuFeatureStatus = vi.fn((): unknown => ({ webgl: "enabled" }));
  const captureGpuInfo = vi.fn(async () => ({
    gpuDevice: [{ vendorId: 0x106b, deviceId: 1 }]
  }));
  const captureNativeRuntime = vi.fn(async () => nativeRuntime());
  const captureBrowserPerformance = vi.fn(async () => browserPerformance());
  const invoke = vi.fn(async (command: CoreCommand) => ({
    filePath: command.type === "diagnosticsExport" ? command.path : "",
    logFileCount: 4
  }));
  const diagnostics = new ElectronDiagnosticsExport({
    core: { invoke: invoke as never },
    resolveMainWindow,
    showNativeSaveDialog,
    captureApplication,
    captureRuntimeVersions,
    captureDisplayTopology,
    captureGpuFeatureStatus,
    captureGpuInfo,
    captureNativeRuntime,
    captureBrowserPerformance
  });
  return {
    captureApplication,
    captureBrowserPerformance,
    captureDisplayTopology,
    captureGpuFeatureStatus,
    captureGpuInfo,
    captureNativeRuntime,
    captureRuntimeVersions,
    diagnostics,
    invoke,
    resolveMainWindow,
    showNativeSaveDialog,
    window
  };
}

describe("Electron diagnostics export", () => {
  it("captures exact Electron, Chromium, display, GPU, and native runtime evidence", async () => {
    const state = harness();

    await expect(state.diagnostics.export(identity)).resolves.toEqual({
      filePath: "/tmp/Rion-Studio-Diagnostics.zip",
      logFileCount: 4
    });

    expect(state.showNativeSaveDialog).toHaveBeenCalledWith(state.window, {
      title: "Export Rion Studio Diagnostics",
      defaultName: "Rion-Studio-Diagnostics.zip",
      extension: "zip"
    });
    expect(state.invoke).toHaveBeenCalledWith({
      type: "diagnosticsExport",
      path: "/tmp/Rion-Studio-Diagnostics.zip",
      snapshot: {
        applicationName: "Rion Studio",
        applicationVersion: "23.4.5",
        buildCommit: "abc123",
        packaged: true,
        engine: "chromium",
        engineVersion: "150.0.7339.12",
        shell: "electron",
        shellVersion: "43.4.1",
        locale: "zh-TW",
        systemVersion: "macOS 15.6",
        displays: [{
          bounds: { x: 0, y: 0, width: 1512, height: 982 },
          resolution: { width: 3024, height: 1964 },
          scaleFactor: 2
        }],
        gpuFeatureStatusRawJson: "{\"webgl\":\"enabled\"}",
        gpuInfoRawJson:
          "{\"gpuDevice\":[{\"vendorId\":4203,\"deviceId\":1}]}",
        browserPerformance: browserPerformance(),
        nativeRuntime: nativeRuntime()
      }
    });
    expect(state.resolveMainWindow).toHaveBeenCalledTimes(3);
  });

  it("returns exact null on dialog cancellation without capturing or invoking Core", async () => {
    const state = harness();
    state.showNativeSaveDialog.mockResolvedValueOnce(null);

    await expect(state.diagnostics.export(identity)).resolves.toBeNull();
    expect(state.captureApplication).not.toHaveBeenCalled();
    expect(state.captureGpuInfo).not.toHaveBeenCalled();
    expect(state.captureNativeRuntime).not.toHaveBeenCalled();
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it("rejects a retired or replaced renderer identity before native/Core effects", async () => {
    const destroyed = harness();
    destroyed.window.destroyed = true;
    await expect(destroyed.diagnostics.export(identity)).rejects.toMatchObject({
      code: "ELECTRON_IPC_UNAUTHORIZED_SENDER"
    });
    expect(destroyed.showNativeSaveDialog).not.toHaveBeenCalled();

    const replaced = harness();
    const replacement = { ...replaced.window };
    replaced.resolveMainWindow
      .mockReturnValueOnce(replaced.window)
      .mockReturnValueOnce(replacement);
    await expect(replaced.diagnostics.export(identity)).rejects.toMatchObject({
      code: "ELECTRON_IPC_UNAUTHORIZED_SENDER"
    });
    expect(replaced.captureApplication).not.toHaveBeenCalled();
    expect(replaced.invoke).not.toHaveBeenCalled();
  });

  it("fails closed on invalid native paths and non-serializable GPU evidence", async () => {
    const path = harness();
    path.showNativeSaveDialog.mockResolvedValueOnce("relative/diagnostics.zip");
    await expect(path.diagnostics.export(identity)).rejects.toMatchObject({
      code: "ELECTRON_DIAGNOSTICS_PATH_INVALID"
    });
    expect(path.invoke).not.toHaveBeenCalled();

    const gpu = harness();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    gpu.captureGpuFeatureStatus.mockReturnValueOnce(cyclic);
    await expect(gpu.diagnostics.export(identity)).rejects.toMatchObject({
      code: "ELECTRON_DIAGNOSTICS_GPU_SNAPSHOT_INVALID"
    });
    expect(gpu.invoke).not.toHaveBeenCalled();
  });
});
