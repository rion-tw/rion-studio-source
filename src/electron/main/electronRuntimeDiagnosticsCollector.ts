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

const INCOMPLETE_COLLECTION_CODES = Object.freeze([
  "ELECTRON_RUNTIME_SURFACE_PHASE_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_HEALTH_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_RECOVERY_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_INPUT_DIAGNOSTICS_UNAVAILABLE",
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
  readonly readCoreSnapshot: () => Promise<CoreAppSnapshotRecord>;
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
 * Captures the exact v23 state currently observable by Electron main.
 *
 * Historical input, operation, and kernel diagnostics do not yet have a v23
 * producer. They are therefore explicitly classified as unavailable instead
 * of being represented by invented zero counts. Required arrays remain empty
 * transport fields while `snapshotComplete` stays false.
 */
export class ElectronRuntimeDiagnosticsCollector {
  readonly #input: ElectronRuntimeDiagnosticsCollectorInput;

  constructor(input: ElectronRuntimeDiagnosticsCollectorInput) {
    this.#input = input;
  }

  async capture(): Promise<SystemRuntimeDiagnosticsRecord> {
    const core = await this.#input.readCoreSnapshot();
    const native = this.#input.readNativeSnapshot();
    const capturedAt = (this.#input.now ?? (() => new Date().toISOString()))();
    this.#input.projectCoherentSnapshot(core, native, capturedAt);
    const registration = this.#input.registration();
    const collectionErrorCodes = [...INCOMPLETE_COLLECTION_CODES];

    return {
      contractVersion: registration.contractVersion,
      platform: registration.platform,
      shutdownState: "accepting",
      applicationLifecycle: this.#input.applicationLifecycle(),
      healthy: false,
      snapshotComplete: collectionErrorCodes.length === 0,
      collectionErrorCodes,
      displayHostCount: native.windows.length,
      tabCount: native.tabs.length,
      roleCount: native.roles.length,
      managedSurfaceCount: native.roles.length + native.webSurfaces.length,
      nativeCreationLimit: UNKNOWN_NATIVE_CREATION_LIMIT,
      activeInputFences: [],
      recentInputFenceEvents: [],
      recentMacroStartAttempts: [],
      recentFailures: [],
      recentOperations: [],
      capabilityEvidence: capabilityEvidence(registration),
      recentRuntimeKernelOperations: []
    };
  }
}
