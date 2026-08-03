import type { SystemRuntimeOperationSummaryRecord } from "../../../shared/generated";

export const SYSTEM_RUNTIME_WARNING_EVENT = "rion:system-runtime-warning";

export interface SystemRuntimeWarningDetail {
  code: string;
  message: string;
  receipt: SystemRuntimeOperationSummaryRecord;
}

export function handleSystemRuntimeReceipt(
  receipt: SystemRuntimeOperationSummaryRecord
): SystemRuntimeOperationSummaryRecord {
  if (
    receipt.status === "applied"
    || receipt.status === "superseded"
    || receipt.status === "cancelled"
  ) {
    return receipt;
  }
  const code = receipt.failureCode ?? "SYSTEM_NATIVE_OPERATION_FAILED";
  if (receipt.status === "degraded") {
    window.dispatchEvent(new CustomEvent<SystemRuntimeWarningDetail>(
      SYSTEM_RUNTIME_WARNING_EVENT,
      {
        detail: {
          code,
          message: `The native operation completed with reduced guarantees (${code}).`,
          receipt
        }
      }
    ));
    return receipt;
  }
  if (receipt.status === "indeterminate") {
    throw {
      code,
      message: `The native operation could not be confirmed (${code}). Restart Rion Studio before trying again.`
    };
  }
  throw {
    code,
    message: `The native operation failed (${code}).`
  };
}
