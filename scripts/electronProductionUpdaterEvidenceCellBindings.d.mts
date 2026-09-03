export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_BUNDLE_BINDINGS_FILE:
  "bundle-bindings.json";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_BINDINGS_FILE:
  "endpoint-observation-bindings.json";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_CELL_BINDINGS_KIND:
  "rion-electron-production-updater-evidence-cell-bindings";

export interface ElectronProductionUpdaterEvidenceCellBindingsDependencies {
  readonly readDescriptor?:
    typeof import("./electronProductionUpdaterTrustedControlIntake.mjs")["readElectronProductionUpdaterTrustedControlDescriptor"];
  readonly readLineage?:
    typeof import("./tauriV22PublicLineage.mjs")["readTauriV22PublicLineageReceipt"];
  readonly readPlan?:
    typeof import("./electronProductionUpdaterEvidenceAttemptPlan.mjs")["readElectronProductionUpdaterEvidenceAttemptPlan"];
  readonly readTrustedBindings?:
    typeof import("./electronProductionUpdaterTrustedControlIntake.mjs")["readElectronProductionUpdaterTrustedControlBindings"];
  readonly verifyCandidate?:
    typeof import("./electronProductionCandidateVerifier.mjs")["verifyElectronProductionCandidateBundle"];
}

export function createElectronProductionUpdaterEvidenceCellBindings(
  input: Readonly<{
    attemptPlanPath: string;
    descriptorPath: string;
    expectedAttemptPlanSha256: string;
    expectedTrustedBindingsSha256: string;
    outputRoot: string;
    platform: "darwin-aarch64" | "windows-x86_64";
    transitionKind:
      | "tauri-v22-to-electron-v23"
      | "electron-v23-to-electron-v23";
    trustedBindingsPath: string;
  }>,
  dependencyOverrides?: ElectronProductionUpdaterEvidenceCellBindingsDependencies
): Promise<Readonly<{
  schemaVersion: 1;
  kind: "rion-electron-production-updater-evidence-cell-bindings";
  platform: "darwin-aarch64" | "windows-x86_64";
  transitionKind:
    | "tauri-v22-to-electron-v23"
    | "electron-v23-to-electron-v23";
  outputRoot: string;
  bundleBindings: Readonly<Record<string, unknown>>;
  bundleIdentity: Readonly<{ bytes: number; fileName: string; sha256: string }>;
  endpointBindings: Readonly<Record<string, unknown>>;
  endpointIdentity: Readonly<{ bytes: number; fileName: string; sha256: string }>;
}>>;
