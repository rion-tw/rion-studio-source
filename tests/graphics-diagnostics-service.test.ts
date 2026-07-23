import { describe, expect, it, vi } from "vitest";

import { GraphicsDiagnosticsService } from "../src/main/game-browser/GraphicsDiagnosticsService";
import {
  DEFAULT_BROWSER_GRAPHICS_SETTINGS,
  LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS
} from "../src/shared/browserFonts";

const probe = {
  renderer: "ANGLE Metal Renderer",
  vendor: "Apple",
  webgl: "available",
  webgl2: "available",
  webgpu: "available"
};

describe("GraphicsDiagnosticsService", () => {
  it("submits only raw Electron probes to the Rust diagnostics assembler", async () => {
    const diagnostics = {
      appliedSettings: LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS,
      appliedSwitches: [],
      collectedAt: "2026-07-23T00:00:00.000Z",
      embedded: probe,
      externalRoles: [],
      featureStatus: { webgl: "enabled" },
      gpuInfoReady: true,
      hardwareAccelerationEnabled: true,
      platform: "darwin",
      restartRequired: false,
      savedSettings: LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS,
      versions: { chromium: "140", electron: "40", node: "24" }
    };
    const invoke = vi.fn(async () => diagnostics);
    const app = {
      getGPUFeatureStatus: vi.fn(() => ({ webgl: "enabled", malformed: 7 })),
      getGPUInfo: vi.fn().mockResolvedValue({
        gpuDevice: [{ active: true, deviceString: "Apple M GPU" }]
      }),
      isHardwareAccelerationEnabled: vi.fn(() => true)
    };
    const service = new GraphicsDiagnosticsService({
      app: app as never,
      appliedSettings: LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS,
      core: { invoke } as never,
      isGpuInfoReady: () => true,
      platform: "darwin",
      versions: { chrome: "140", electron: "40", node: "24" } as NodeJS.ProcessVersions
    });

    await expect(service.collect({
      executeJavaScript: vi.fn().mockResolvedValue(probe)
    })).resolves.toEqual(diagnostics);

    expect(invoke).toHaveBeenCalledWith({
      type: "graphicsDiagnosticsAssemble",
      appliedSettings: LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS,
      embeddedRawJson: JSON.stringify(probe),
      gpuInfoRawJson: JSON.stringify({
        gpuDevice: [{ active: true, deviceString: "Apple M GPU" }]
      }),
      featureStatusRawJson: JSON.stringify({ webgl: "enabled", malformed: 7 }),
      gpuInfoReady: true,
      hardwareAccelerationEnabled: true,
      platform: "darwin",
      versions: { chromium: "140", electron: "40", node: "24" }
    });
  });

  it("passes explicit partial raw inputs before Electron reports GPU readiness", async () => {
    const invoke = vi.fn(async (command) => command);
    const app = {
      getGPUFeatureStatus: vi.fn(),
      getGPUInfo: vi.fn(),
      isHardwareAccelerationEnabled: vi.fn()
    };
    const service = new GraphicsDiagnosticsService({
      app: app as never,
      appliedSettings: DEFAULT_BROWSER_GRAPHICS_SETTINGS,
      core: { invoke } as never,
      isGpuInfoReady: () => false,
      platform: "win32",
      versions: { chrome: "140", electron: "40", node: "24" } as NodeJS.ProcessVersions
    });

    await service.collect({
      executeJavaScript: vi.fn().mockRejectedValue(new Error("probe unavailable"))
    });

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      type: "graphicsDiagnosticsAssemble",
      embeddedRawJson: "null",
      embeddedError: "probe unavailable",
      featureStatusRawJson: "{}",
      gpuInfoReady: false,
      hardwareAccelerationEnabled: null,
      platform: "win32"
    }));
    expect(app.getGPUInfo).not.toHaveBeenCalled();
    expect(app.getGPUFeatureStatus).not.toHaveBeenCalled();
    expect(app.isHardwareAccelerationEnabled).not.toHaveBeenCalled();
  });
});
