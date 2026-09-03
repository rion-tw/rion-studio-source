import type {
  ElectronProductionPromotionReadinessReceipt
} from "./electronProductionPromotionReadiness.mjs";

export function runElectronProductionPromotionReadinessCli(
  argumentsList?: readonly string[],
  environment?: NodeJS.ProcessEnv
): Promise<Readonly<ElectronProductionPromotionReadinessReceipt>>;
