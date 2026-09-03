import { describe, expect, it, vi } from "vitest";

import { ElectronRuntimeDiagnosticsCollector } from
  "../src/electron/main/electronRuntimeDiagnosticsCollector";

const registration = {
  contractVersion: 23,
  platform: "macos" as const,
  engine: "chromium" as const,
  adapterVersion: "appkit-4+electron-43+chromium-140",
  available: true,
  capabilities: {
    navigation: "supported" as const,
    persistentSession: "supported" as const,
    trustedInput: "supported" as const,
    backgroundInput: "supported" as const,
    frameEvaluation: "degraded" as const,
    popup: "supported" as const,
    audioMute: "supported" as const,
    customFonts: "supported" as const,
    downloads: "disabled" as const,
    fileUpload: "supported" as const,
    permissions: "degraded" as const,
    dialogs: "supported" as const,
    certificateHandling: "supported" as const
  }
};

describe("Electron runtime diagnostics collector", () => {
  it("exports exact observable counts and conservative unavailable fields", async () => {
    const core = {
      browserRuntime: {
        roles: [
          { state: "launching", owner: { tabId: "tab-1" } },
          { state: "launching", owner: { tabId: "tab-1" } },
          { state: "running", owner: { tabId: "tab-2" } }
        ]
      }
    };
    const native = {
      windows: [{ windowId: "window-1" }],
      tabs: [{ tabId: "tab-1" }, { tabId: "tab-2" }],
      roles: [{ roleId: "role-1" }, { roleId: "role-2" }],
      webSurfaces: [{ surfaceId: "web-1" }]
    };
    const projectCoherentSnapshot = vi.fn(() => ({
      embeddedRuntimeState: { recovery: { interrupted: true } }
    }));
    const collector = new ElectronRuntimeDiagnosticsCollector({
      applicationLifecycle: () => ({ phase: "running" }) as never,
      projectCoherentSnapshot: projectCoherentSnapshot as never,
      readCoreSnapshot: async () => core as never,
      readNativeSnapshot: () => native as never,
      registration: () => registration,
      now: () => "2026-08-31T00:00:00.000Z"
    });

    const result = await collector.capture();

    expect(projectCoherentSnapshot).toHaveBeenCalledWith(
      core,
      native,
      "2026-08-31T00:00:00.000Z"
    );
    expect(result).toMatchObject({
      contractVersion: 23,
      platform: "macos",
      shutdownState: "accepting",
      healthy: false,
      snapshotComplete: false,
      displayHostCount: 1,
      tabCount: 2,
      roleCount: 2,
      managedSurfaceCount: 3,
      nativeCreationLimit: 0
    });
    expect(result).not.toHaveProperty("recoveryRequired");
    expect(result).not.toHaveProperty("launchingTabCount");
    expect(result.collectionErrorCodes).toContain(
      "ELECTRON_RUNTIME_HEALTH_DIAGNOSTICS_UNAVAILABLE"
    );
    expect(result.collectionErrorCodes).toContain(
      "ELECTRON_RUNTIME_RECOVERY_DIAGNOSTICS_UNAVAILABLE"
    );
    expect(result.collectionErrorCodes).toContain(
      "ELECTRON_RUNTIME_LAUNCH_DIAGNOSTICS_UNAVAILABLE"
    );
    expect(result.collectionErrorCodes).toContain(
      "ELECTRON_RUNTIME_NATIVE_CREATION_DIAGNOSTICS_UNAVAILABLE"
    );
    expect(result.collectionErrorCodes).toContain(
      "ELECTRON_RUNTIME_OPERATION_DIAGNOSTICS_UNAVAILABLE"
    );
    expect(result.capabilityEvidence).toContainEqual({
      capability: "downloads",
      status: "disabled",
      contractVersion: 23,
      probeResult: "static-registration:disabled",
      policyMode: "electron-chromium-static-registration",
      evidenceStage: "staticRegistrationSnapshot"
    });
  });

  it("rejects export when the Core/native/display coherence proof fails", async () => {
    const collector = new ElectronRuntimeDiagnosticsCollector({
      applicationLifecycle: vi.fn() as never,
      projectCoherentSnapshot: () => {
        throw new Error("stale topology");
      },
      readCoreSnapshot: async () => ({
        browserRuntime: { roles: [] }
      }) as never,
      readNativeSnapshot: () => ({
        windows: [], tabs: [], roles: [], webSurfaces: []
      }),
      registration: () => registration
    });

    await expect(collector.capture()).rejects.toThrow("stale topology");
  });
});
