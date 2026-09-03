import type {
  ElectronUpdaterCompatibilityReceiptWriteResult,
  ElectronUpdaterCompatibilityTerminalReceipt
} from "./electronUpdaterCompatibilityReceiptFinalizer.mjs";

export function finalizeWindowsElectronUpdaterCompatibilityReceipt(
  argumentsList: readonly string[]
): Promise<ElectronUpdaterCompatibilityReceiptWriteResult<
  ElectronUpdaterCompatibilityTerminalReceipt
>>;
