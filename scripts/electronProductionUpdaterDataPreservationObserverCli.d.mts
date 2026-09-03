export const ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_CLI_SUMMARY_KIND:
  "rion-production-updater-data-preservation-cli-summary";

export type ElectronProductionUpdaterDataPreservationCliSummary =
  | Readonly<{
      schemaVersion: 1;
      kind: "rion-production-updater-data-preservation-cli-summary";
      command: "prepare";
      status: "prepared";
      artifact: Readonly<{
        bytes: number;
        fileName: "data-preservation-before.json";
        sha256: string;
      }>;
      sentinel: Readonly<{
        bytes: 32;
        fileName: ".rion-production-updater-evidence-challenge";
        sha256: string;
      }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "rion-production-updater-data-preservation-cli-summary";
      command: "finalize";
      status: "observed";
      artifact: Readonly<{
        bytes: number;
        fileName: "data-preservation-observation.json";
        sha256: string;
      }>;
      userDataIdentitySha256: string;
    }>;

export interface ElectronProductionUpdaterDataPreservationCliDependencies {
  readonly now?: () => Date;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionUpdaterDataPreservationObserverCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionUpdaterDataPreservationCliDependencies
): Promise<Readonly<ElectronProductionUpdaterDataPreservationCliSummary>>;
