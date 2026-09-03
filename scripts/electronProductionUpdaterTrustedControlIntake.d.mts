import type {
  ElectronProductionUpdaterEvidenceAttemptPlanBindings
} from "./electronProductionUpdaterEvidenceAttemptPlan.mjs";

export const ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_INTAKE_KIND:
  "rion-electron-production-updater-trusted-control-intake";
export const ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_BINDINGS_FILE:
  "electron-production-updater-evidence-attempt-plan-bindings.json";

export interface ElectronProductionUpdaterTrustedControlIntakeDependencies {
  readonly assertTauriLineagePair?:
    typeof import("./tauriV22PublicLineage.mjs")["assertTauriV22PublicLineagePair"];
  readonly readPublicationReceipt?:
    typeof import("./electronProductionPublicationReceipt.mjs")["readElectronProductionPublicationReceipt"];
  readonly readTauriLineage?:
    typeof import("./tauriV22PublicLineage.mjs")["readTauriV22PublicLineageReceipt"];
  readonly readTrustedControl?:
    typeof import("./electronProductionCandidateTrustedControl.mjs")["readTrustedControlReceipt"];
  readonly verifyCandidate?:
    typeof import("./electronProductionCandidateVerifier.mjs")["verifyElectronProductionCandidateBundle"];
}

export interface ElectronProductionUpdaterTrustedControlBindingsFile {
  readonly bindings: Readonly<ElectronProductionUpdaterEvidenceAttemptPlanBindings>;
  readonly bindingsIdentity: Readonly<{
    bytes: number;
    fileName: "electron-production-updater-evidence-attempt-plan-bindings.json";
    sha256: string;
  }>;
  readonly bindingsPath: string;
  readonly descriptorIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
}

export function createElectronProductionUpdaterTrustedControlBindings(
  input: Readonly<{ descriptorPath: string; outputPath: string }>,
  dependencyOverrides?: ElectronProductionUpdaterTrustedControlIntakeDependencies
): Promise<Readonly<ElectronProductionUpdaterTrustedControlBindingsFile>>;

export function readElectronProductionUpdaterTrustedControlDescriptor(
  input: Readonly<{ descriptorPath: string }>
): Promise<Readonly<{
  descriptor: Readonly<Record<string, unknown>>;
  descriptorIdentity: Readonly<{ bytes: number; fileName: string; sha256: string }>;
  descriptorPath: string;
}>>;

export function readElectronProductionUpdaterTrustedControlBindings(
  input: Readonly<{ bindingsPath: string; expectedSha256: string }>
): Promise<Readonly<{
  bindings: ElectronProductionUpdaterEvidenceAttemptPlanBindings;
  bindingsIdentity: Readonly<{ bytes: number; fileName: string; sha256: string }>;
  bindingsPath: string;
}>>;
