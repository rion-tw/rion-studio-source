import type {
  ElectronProductionTerminalPromotionReceipt
} from "./electronProductionTerminalPromotion.mjs";

export function runElectronProductionTerminalPromotionCli(
  argumentsList?: readonly string[],
  environment?: NodeJS.ProcessEnv
): Promise<Readonly<{
  receipt: Readonly<ElectronProductionTerminalPromotionReceipt>;
  receiptIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  receiptPath: string;
}>>;
