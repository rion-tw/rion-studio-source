import type {
  ElectronProductionUpdaterEvidenceEndpointObservationDependencies,
  ElectronProductionUpdaterEvidenceEndpointPlatform,
  ElectronProductionUpdaterEvidenceEndpointTransition
} from "./electronProductionUpdaterEvidenceEndpointObservation.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_CLI_SUMMARY_KIND:
  "rion-production-updater-endpoint-observation-cli-summary";

export interface ElectronProductionUpdaterEvidenceEndpointObservationCliSummary {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-endpoint-observation-cli-summary";
  readonly command: "observe" | "verify";
  readonly status: "prebound" | "verified";
  readonly attemptPlanSha256: string;
  readonly cell: Readonly<{
    evidenceAttemptId: string;
    platform: ElectronProductionUpdaterEvidenceEndpointPlatform;
    transitionKind: ElectronProductionUpdaterEvidenceEndpointTransition;
  }>;
  readonly artifact: Readonly<{
    bytes: number;
    fileName: "endpoint-observation.json";
    sha256: string;
  }>;
}

export interface ElectronProductionUpdaterEvidenceEndpointObservationCliDependencies
  extends ElectronProductionUpdaterEvidenceEndpointObservationDependencies {
  readonly signal?: AbortSignal;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionUpdaterEvidenceEndpointObservationCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionUpdaterEvidenceEndpointObservationCliDependencies
): Promise<Readonly<
  ElectronProductionUpdaterEvidenceEndpointObservationCliSummary
>>;
