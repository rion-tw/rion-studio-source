import { normalizeRionBridgeError } from "../ipc/errors";
import { runtimeOperationEvidence } from "./runtimeOperationJournal";
import type {
  ApplicationLifecycleStatusRecord,
  BrowserRuntimeRegistrationRecord,
  CoreAppSnapshotRecord,
  EngineCapabilityEvidenceRecord,
  SystemRuntimeDiagnosticsRecord
} from "../../shared/generated";
import type { AppSnapshot } from "../../shared/types";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeEffectExecutor";
import { recentTrustedInputTerminals, trustedInputDiagnostics } from
  "./chromiumTrustedInputTerminalJournal";
import { recentChromiumExtensionRuntimeFailures } from
  "./chromiumExtensionRuntimeDiagnostics";

const INCOMPLETE_COLLECTION_CODES = Object.freeze([
  "ELECTRON_RUNTIME_SURFACE_PHASE_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_HEALTH_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_RECOVERY_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_MACRO_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_LAUNCH_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_NATIVE_CREATION_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_OPERATION_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_KERNEL_DIAGNOSTICS_UNAVAILABLE"
] as const);

// SystemRuntimeDiagnosticsRecord still requires these legacy transport fields.
// Until the v23 dynamic producers exist, use non-success sentinels paired with
// explicit collection-error codes rather than asserting invented measurements.
const UNKNOWN_NATIVE_CREATION_LIMIT = 0;

export interface ElectronRuntimeDiagnosticsCollectorInput {
  readonly applicationLifecycle: () => ApplicationLifecycleStatusRecord;
  readonly projectCoherentSnapshot: (
    core: CoreAppSnapshotRecord,
    native: ChromiumRuntimeExecutorSnapshot,
    capturedAt: string
  ) => AppSnapshot;
  readonly readCachedCoreSnapshot?: () => { capturedAt: string; snapshot: CoreAppSnapshotRecord } | null;
  readonly readCoreSnapshot?: () => Promise<CoreAppSnapshotRecord>;
  readonly readCachedNativeSnapshot?: () => { capturedAt: string; snapshot: ChromiumRuntimeExecutorSnapshot } | null;
  readonly readNativeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
  readonly registration: () => BrowserRuntimeRegistrationRecord;
  readonly now?: () => string;
}

function capabilityEvidence(
  registration: BrowserRuntimeRegistrationRecord
): EngineCapabilityEvidenceRecord[] {
  return Object.entries(registration.capabilities)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([capability, status]) => ({
      capability,
      status,
      contractVersion: registration.contractVersion,
      probeResult: `static-registration:${status}`,
      policyMode: "electron-chromium-static-registration",
      evidenceStage: "staticRegistrationSnapshot",
      ...(
        (status === "disabled" || status === "unsupported") &&
        registration.failureReason !== undefined
          ? { failureReason: registration.failureReason }
          : {}
      )
    }));
}

/**
 * Captures the exact current Chromium-contract state observable by Electron main.
 *
 * The bounded trusted-input terminal journal remains available after a Role
 * closes. Other historical operation and kernel producers that do not yet
 * exist remain explicitly unavailable instead of receiving invented values.
 */
export class ElectronRuntimeDiagnosticsCollector {
  readonly #input: ElectronRuntimeDiagnosticsCollectorInput;
  readonly #registration: BrowserRuntimeRegistrationRecord;

  constructor(input: ElectronRuntimeDiagnosticsCollectorInput) {
    this.#input = input;
    this.#registration = structuredClone(input.registration());
  }

  async capture(): Promise<SystemRuntimeDiagnosticsRecord> {
    const capturedAt = (this.#input.now ?? (() => new Date().toISOString()))();
    const collectionErrorCodes: string[] = [...INCOMPLETE_COLLECTION_CODES];
    let core: CoreAppSnapshotRecord | undefined;
    let coreCapturedAt = capturedAt;
    let native: ChromiumRuntimeExecutorSnapshot | undefined;
    let nativeCapturedAt = capturedAt;
    let nativeSource = "live";
    let applicationLifecycle: ApplicationLifecycleStatusRecord | undefined;
    try {
      if (this.#input.readCachedCoreSnapshot) {
        const cached = this.#input.readCachedCoreSnapshot();
        core = cached?.snapshot;
        coreCapturedAt = cached?.capturedAt ?? capturedAt;
        collectionErrorCodes.push(core ? "ELECTRON_RUNTIME_CORE_SNAPSHOT_CACHED" : "ELECTRON_RUNTIME_CORE_SNAPSHOT_UNAVAILABLE");
      } else if (this.#input.readCoreSnapshot) core = await this.#input.readCoreSnapshot();
      else collectionErrorCodes.push("ELECTRON_RUNTIME_CORE_SNAPSHOT_UNAVAILABLE");
    } catch (error) { collectionErrorCodes.push(normalizeRionBridgeError(error, "ELECTRON_RUNTIME_CORE_SNAPSHOT_UNAVAILABLE").code); }
    try { native = this.#input.readNativeSnapshot(); }
    catch (error) {
      collectionErrorCodes.push(normalizeRionBridgeError(error, "ELECTRON_RUNTIME_NATIVE_SNAPSHOT_UNAVAILABLE").code);
      try {
        const cached = this.#input.readCachedNativeSnapshot?.();
        if (cached) { native = cached.snapshot; nativeCapturedAt = cached.capturedAt; nativeSource = "cached"; }
      } catch { collectionErrorCodes.push("ELECTRON_RUNTIME_NATIVE_CACHE_UNAVAILABLE"); }
    }
    try { applicationLifecycle = this.#input.applicationLifecycle(); }
    catch (error) { collectionErrorCodes.push(normalizeRionBridgeError(error, "ELECTRON_RUNTIME_LIFECYCLE_UNAVAILABLE").code); }
    let projectionFailure: { code: string; message: string } | undefined;
    if (core && native) {
      try { this.#input.projectCoherentSnapshot(core, native, capturedAt); }
      catch (error) {
        projectionFailure = normalizeRionBridgeError(error, "ELECTRON_RUNTIME_PROJECTION_UNAVAILABLE");
        collectionErrorCodes.push(projectionFailure.code);
      }
    }
    let registration = this.#registration;
    try { registration = this.#input.registration(); }
    catch { collectionErrorCodes.push("ELECTRON_RUNTIME_REGISTRATION_CACHED"); }
    const evidence = {
      capturedAt,
      collection: { unavailableLegacyFields: [...INCOMPLETE_COLLECTION_CODES],
        ...(projectionFailure ? { projectionFailure } : {}) },
      core: core ? { capturedAt: coreCapturedAt,
        source: this.#input.readCachedCoreSnapshot ? "cached" : "live",
        revision: core.revision, runtimeRevision: core.runtimeRevision,
        browserRuntime: core.browserRuntime ? { windows: core.browserRuntime.windows,
          roles: core.browserRuntime.roles, tabs: core.browserRuntime.tabs?.map(tab => ({
            tabId: tab.id, windowId: tab.windowId, attemptGeneration: tab.attemptGeneration,
            sourceId: tab.sourceId, tabType: tab.tabType, hidden: tab.hidden
          })) } : null,
        windows: core.logicalWindows?.map(window => ({ windowId: window.windowId,
          windowGeneration: window.windowGeneration, revision: window.revision,
          tabIds: window.tabs.map(tab => tab.id), activeTabId: window.activeTabId }))
      } : null,
      native: native ? { capturedAt: nativeCapturedAt, source: nativeSource, windows: native.windows, tabs: native.tabs,
        roles: native.roles, webSurfaces: native.webSurfaces } : null,
      effects: runtimeOperationEvidence()
    };

    return {
      contractVersion: registration.contractVersion,
      platform: registration.platform,
      shutdownState: "accepting",
      ...(applicationLifecycle ? { applicationLifecycle } : {}),
      healthy: false,
      snapshotComplete: collectionErrorCodes.length === 0,
      collectionErrorCodes,
      runtimeEvidenceRawJson: JSON.stringify(evidence),
      ...(native ? { displayHostCount: native.windows.length, tabCount: native.tabs.length,
        roleCount: native.roles.length, managedSurfaceCount: native.roles.length + native.webSurfaces.length } : {}),
      nativeCreationLimit: UNKNOWN_NATIVE_CREATION_LIMIT,
      activeInputFences: [],
      recentInputFenceEvents: [],
      recentTrustedInputTerminals: recentTrustedInputTerminals(),
      trustedInputDiagnostics: trustedInputDiagnostics(),
      recentMacroStartAttempts: [],
      recentFailures: recentChromiumExtensionRuntimeFailures(),
      recentOperations: [],
      capabilityEvidence: capabilityEvidence(registration),
      recentRuntimeKernelOperations: []
    };
  }
}
