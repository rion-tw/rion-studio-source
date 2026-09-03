import type {
  ElectronProductionUpdaterEvidenceNativeHostDependencies
} from "./electronProductionUpdaterEvidenceNativeHostObservation.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_CLI_SUMMARY_KIND:
  "rion-production-updater-native-host-observation-cli-summary";

export interface ElectronProductionUpdaterEvidenceNativeHostCliSummary {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-native-host-observation-cli-summary";
  readonly command: "observe" | "verify";
  readonly status: "observed" | "verified";
  readonly artifact: Readonly<{
    bytes: number;
    fileName: "native-host-observation.json";
    sha256: string;
  }>;
}

export interface ElectronProductionUpdaterEvidenceNativeHostCliDependencies
  extends ElectronProductionUpdaterEvidenceNativeHostDependencies {
  readonly signal?: AbortSignal;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionUpdaterEvidenceNativeHostObservationCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: ElectronProductionUpdaterEvidenceNativeHostCliDependencies
): Promise<Readonly<ElectronProductionUpdaterEvidenceNativeHostCliSummary>>;
