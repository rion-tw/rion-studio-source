import type {
  ElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import type {
  ElectronProductionPublicationReceiptFile
} from "./electronProductionPublicationReceipt.mjs";
import type {
  ElectronProductionPublicationStagingPlanFile
} from "./electronProductionPublicationStagingPlan.mjs";

export type ElectronProductionPublicationCliResult =
  | Readonly<{
      file: Readonly<{ bytes: number; sha256: string }>;
      snapshot: ElectronProductionPublicLatestSnapshot;
    }>
  | Readonly<ElectronProductionPublicationReceiptFile>
  | Readonly<ElectronProductionPublicationStagingPlanFile>;

export function runElectronProductionPublicationCli(
  argumentsList?: readonly string[]
): Promise<ElectronProductionPublicationCliResult>;
