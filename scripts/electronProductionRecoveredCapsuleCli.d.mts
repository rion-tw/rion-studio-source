import type {
  ElectronProductionRecoveredCapsuleInput,
  ElectronProductionRecoveredCapsuleVerification
} from "./electronProductionRecoveredCapsule.mjs";

export const ELECTRON_PRODUCTION_RECOVERED_CAPSULE_CLI_SUMMARY_KIND:
  "rion-electron-production-recovered-capsule-cli-summary";

export interface ElectronProductionRecoveredCapsuleCliSummary {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-recovered-capsule-cli-summary";
  readonly command: "verify-recovered" | "materialize-recovered";
  readonly status: "verified" | "materialized";
  readonly verification: Readonly<ElectronProductionRecoveredCapsuleVerification>;
}

export interface ElectronProductionRecoveredCapsuleCliDependencies {
  readonly materializeRecovered?: (
    input: Readonly<ElectronProductionRecoveredCapsuleInput & {
      outputRoot: string;
    }>
  ) => Promise<Readonly<{
    materializedRoot: string;
    verification: Readonly<ElectronProductionRecoveredCapsuleVerification>;
  }>>;
  readonly verifyRecovered?: (
    input: Readonly<ElectronProductionRecoveredCapsuleInput>
  ) => Promise<Readonly<ElectronProductionRecoveredCapsuleVerification>>;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionRecoveredCapsuleCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: ElectronProductionRecoveredCapsuleCliDependencies
): Promise<Readonly<ElectronProductionRecoveredCapsuleCliSummary>>;
