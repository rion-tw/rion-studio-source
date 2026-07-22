import { describe, expect, it, vi } from "vitest";

import { GraphicsDiagnosticsService } from "../src/main/game-browser/GraphicsDiagnosticsService";

const probe = {
  renderer: "ANGLE Metal Renderer",
  vendor: "Apple",
  webgl: "available",
  webgl2: "available",
  webgpu: "available"
};

describe("GraphicsDiagnosticsService", () => {
  it("collects Electron GPU state and only probes already-running external sessions", async () => {
    const externalEvaluate = vi.fn().mockResolvedValue(probe);
    const app = {
      getGPUFeatureStatus: vi.fn(() => ({
        gpu_compositing: "enabled",
        rasterization: "enabled_on",
        webgl: "enabled",
        webgl2: "enabled"
      })),
      getGPUInfo: vi.fn().mockResolvedValue({
        auxAttributes: { driverVendor: "Apple", driverVersion: "1.0" },
        gpuDevice: [{ active: true, deviceId: 2, deviceString: "Apple M GPU", vendorId: 1 }]
      }),
      isHardwareAccelerationEnabled: vi.fn(() => true)
    };
    const service = new GraphicsDiagnosticsService({
      app: app as never,
      appliedMode: "high_performance",
      browserManager: {
        evaluateExternalRole: externalEvaluate,
        getExternalRoleName: vi.fn(() => "Alt"),
        listStatuses: vi.fn(() => [
          { roleId: "embedded-1", runtimeMode: "embedded", state: "running" },
          {
            roleId: "external-1",
            runtimeMode: "external",
            state: "running",
            automationState: "ready"
          }
        ])
      } as never,
      gameBrowserSettingsStore: {
        getSettings: vi.fn().mockResolvedValue({ graphics: { mode: "experimental" } })
      } as never,
      isGpuInfoReady: () => true,
      platform: "darwin"
    });

    const diagnostics = await service.collect({ executeJavaScript: vi.fn().mockResolvedValue(probe) });

    expect(diagnostics).toMatchObject({
      appliedMode: "high_performance",
      savedMode: "experimental",
      restartRequired: true,
      hardwareAccelerationEnabled: true,
      gpuInfoReady: true,
      gpuDevice: { deviceString: "Apple M GPU", driverVersion: "1.0" },
      embedded: { webgl2: "available", webgpu: "available" },
      externalRoles: [{ roleId: "external-1", roleName: "Alt", state: "ready" }]
    });
    expect(externalEvaluate).toHaveBeenCalledOnce();
    expect(app.getGPUInfo).toHaveBeenCalledWith("basic");
  });

  it("returns partial diagnostics before Electron emits gpu-info-update", async () => {
    const app = {
      getGPUFeatureStatus: vi.fn(),
      getGPUInfo: vi.fn(),
      isHardwareAccelerationEnabled: vi.fn(() => true)
    };
    const service = new GraphicsDiagnosticsService({
      app: app as never,
      appliedMode: "automatic",
      browserManager: { getAutomationSession: vi.fn(), listStatuses: vi.fn(() => []) } as never,
      gameBrowserSettingsStore: {
        getSettings: vi.fn().mockResolvedValue({ graphics: { mode: "automatic" } })
      } as never,
      isGpuInfoReady: () => false
    });

    const diagnostics = await service.collect({ executeJavaScript: vi.fn().mockResolvedValue(probe) });

    expect(diagnostics.gpuInfoReady).toBe(false);
    expect(diagnostics.hardwareAccelerationEnabled).toBeNull();
    expect(diagnostics.featureStatus).toEqual({});
    expect(diagnostics.gpuDevice).toBeUndefined();
    expect(app.getGPUInfo).not.toHaveBeenCalled();
    expect(app.getGPUFeatureStatus).not.toHaveBeenCalled();
    expect(app.isHardwareAccelerationEnabled).not.toHaveBeenCalled();
  });
});
