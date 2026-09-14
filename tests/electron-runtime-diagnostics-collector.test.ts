import { describe, expect, it, vi } from "vitest";

import { ElectronRuntimeDiagnosticsCollector } from
  "../src/electron/main/electronRuntimeDiagnosticsCollector";
import {
  recordTrustedInputTerminal,
  resetTrustedInputTerminalJournalForTest
} from "../src/electron/main/chromiumTrustedInputTerminalJournal";

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
  it("distinguishes unavailable legacy fields from the exact projection failure", async () => {
    const failure = { code: "ELECTRON_RUNTIME_PROJECTION_NOT_READY", message: "Core and Electron disagree on the tab identity set." };
    const collector = new ElectronRuntimeDiagnosticsCollector({
      readCoreSnapshot: async () => ({}) as never,
      readNativeSnapshot: () => ({ windows: [], tabs: [], roles: [], webSurfaces: [] }),
      applicationLifecycle: () => ({ phase: "running" }) as never,
      registration: () => registration,
      projectCoherentSnapshot: () => { throw failure; }
    });
    const result = await collector.capture();
    const evidence = JSON.parse(result.runtimeEvidenceRawJson!);
    expect(evidence.collection.projectionFailure).toEqual(failure);
    expect(evidence.collection.unavailableLegacyFields).not.toContain(failure.code);
    expect(result.collectionErrorCodes).toContain(failure.code);
  });

  it("exports cached Core evidence without awaiting a stalled live read", async () => {
    const live = vi.fn(() => new Promise<never>(() => undefined));
    const cached = { capturedAt: "2026-09-14T10:00:00Z", snapshot: {
      revision: 10, runtimeRevision: 8, logicalWindows: []
    } };
    const collector = new ElectronRuntimeDiagnosticsCollector({
      readCoreSnapshot: live,
      readCachedCoreSnapshot: () => cached as never,
      readNativeSnapshot: () => { throw new Error("native stream stopped"); },
      applicationLifecycle: () => ({ phase: "running" }) as never,
      registration: () => registration,
      projectCoherentSnapshot: vi.fn() as never
    });
    const result = await collector.capture();
    expect(live).not.toHaveBeenCalled();
    expect(result.collectionErrorCodes).toContain("ELECTRON_RUNTIME_NATIVE_SNAPSHOT_UNAVAILABLE");
    expect(result).not.toHaveProperty("displayHostCount");
    expect(JSON.parse(result.runtimeEvidenceRawJson!)).toMatchObject({
      core: { source: "cached", capturedAt: cached.capturedAt, revision: 10, runtimeRevision: 8 }, native: null
    });
  });

  it("retains bounded input terminal evidence after the Role is gone", async () => {
    resetTrustedInputTerminalJournalForTest();
    recordTrustedInputTerminal({
      capturedAt: "2026-09-13T01:00:00.000Z",
      requestId: "request-1",
      roleId: "closed-role",
      inputEpoch: 7,
      surfaceGeneration: 4,
      intent: "normal",
      actionType: "key",
      keyCode: "KeyJ",
      keyPhase: "rawKeyDown",
      modifierOwnership: "synthetic",
      applicationPath: "cdp",
      expectedDomEventCount: 1,
      observedDomEventCount: 0,
      modifierProjectionCodes: ["ShiftLeft"],
      cdpModifierMask: 8,
      lastObservedDomModifierMask: 8,
      cdpSubmissionCertainty: "possibly-submitted",
      physicalInterleave: "unrelated",
      nativePhysicalInputSequenceBefore: "40",
      nativePhysicalInputSequenceAfter: "42",
      nativePhysicalKeyDownSequenceBefore: "20",
      nativePhysicalKeyDownSequenceAfter: "20",
      nativePhysicalKeyUpSequenceBefore: "20",
      nativePhysicalKeyUpSequenceAfter: "21",
      lastObservedDomEventType: "keydown",
      lastObservedDomEventCode: "KeyJ",
      lastPhysicalEvidenceClassification: "automatic",
      terminalCode: "SYSTEM_TRUSTED_INPUT_DOM_RECEIPT_MISMATCH",
      nativeProofChanges: ["targetReceivesPhysicalInput"],
      traceSteps: [{
        sequence: 1,
        source: "cdp",
        stage: "key-command-accepted"
      }],
      traceTruncated: false,
      droppedTraceStepCount: 0,
      cleanupOutcome: "not-attempted",
      recoveryOutcome: "restart-required"
    });
    const collector = new ElectronRuntimeDiagnosticsCollector({
      applicationLifecycle: () => ({ phase: "running" }) as never,
      projectCoherentSnapshot: vi.fn(() => ({})) as never,
      readCoreSnapshot: async () => ({ browserRuntime: { roles: [] } }) as never,
      readNativeSnapshot: () => ({ windows: [], tabs: [], roles: [], webSurfaces: [] }),
      registration: () => registration
    });

    const result = await collector.capture();

    expect(result.collectionErrorCodes).not.toContain(
      "ELECTRON_RUNTIME_INPUT_DIAGNOSTICS_UNAVAILABLE"
    );
    expect(result.recentTrustedInputTerminals).toEqual([
      expect.objectContaining({
        requestId: "request-1",
        roleId: "closed-role",
        physicalInterleave: "unrelated",
        modifierProjectionCodes: ["ShiftLeft"],
        cdpModifierMask: 8,
        lastObservedDomModifierMask: 8,
        nativePhysicalKeyUpSequenceAfter: "21",
        lastObservedDomEventCode: "KeyJ",
        recoveryOutcome: "restart-required"
      })
    ]);
    resetTrustedInputTerminalJournalForTest();
  });

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

  it("retains evidence when the Core/native/display coherence proof fails", async () => {
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

    const result = await collector.capture();
    expect(result.snapshotComplete).toBe(false);
    expect(result.collectionErrorCodes).toContain("ELECTRON_RUNTIME_PROJECTION_UNAVAILABLE");
    expect(JSON.parse(result.runtimeEvidenceRawJson!)).toMatchObject({ native: { windows: [] } });
  });
});
