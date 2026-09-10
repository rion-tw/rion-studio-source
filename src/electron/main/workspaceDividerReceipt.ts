import type {
  BrowserWorkspaceDividerPointerReceiptRecord,
  BrowserWorkspaceDividerPointerRecord
} from "../../shared/generated";

const WORKSPACE_DIVIDER_WINDOW_NOT_SAVED = "WORKSPACE_DIVIDER_WINDOW_NOT_SAVED";

export function isExactWorkspaceDividerReceipt(
  event: BrowserWorkspaceDividerPointerRecord,
  receipt: BrowserWorkspaceDividerPointerReceiptRecord
): boolean {
  const exactOutcome = event.phase === "end"
    ? (
        receipt.status === "applied" &&
        receipt.durable &&
        receipt.failureCode === undefined
      ) || (
        receipt.status === "degraded" &&
        !receipt.durable &&
        receipt.failureCode === WORKSPACE_DIVIDER_WINDOW_NOT_SAVED
      )
    : event.phase === "cancel"
      ? receipt.status === "cancelled" &&
        !receipt.durable &&
        receipt.failureCode === undefined
      : receipt.status === "applied" &&
        !receipt.durable &&
        receipt.failureCode === undefined;
  return receipt.eventId === event.eventId &&
    receipt.gestureId === event.gestureId &&
    receipt.pointerSequence === event.pointerSequence &&
    receipt.phase === event.phase &&
    exactOutcome &&
    receipt.windowGeneration === event.windowGeneration &&
    Number.isSafeInteger(receipt.topologyRevision) &&
    receipt.topologyRevision >= event.topologyRevision &&
    (event.phase === "move" || !receipt.changed);
}
