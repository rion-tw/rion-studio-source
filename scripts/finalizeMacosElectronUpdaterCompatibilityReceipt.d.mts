import type {
  ElectronUpdaterCompatibilityReceiptWriteResult
} from "./electronUpdaterCompatibilityReceiptFinalizer.mjs";
import type {
  ElectronUpdaterMacosCompatibilityTerminalReceipt
} from "./electronUpdaterMacosCompatibilityReceiptFinalizer.mjs";

export function finalizeMacosElectronUpdaterCompatibilityReceipt(
  argumentsList: readonly string[]
): Promise<ElectronUpdaterCompatibilityReceiptWriteResult<
  ElectronUpdaterMacosCompatibilityTerminalReceipt
>>;
