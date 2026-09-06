import type {
  WindowsRuntimeWindowPlacementEventRecord,
  WindowsRuntimeWindowPlacementReceiptRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeWindowRecord } from
  "./chromiumRuntimeAppKitProjection";

export function commitChromiumRuntimeWindowsPlacementTarget(input: Readonly<{
  event: WindowsRuntimeWindowPlacementEventRecord;
  receipt: WindowsRuntimeWindowPlacementReceiptRecord;
  windows: Map<string, ChromiumRuntimeWindowRecord>;
}>): void {
  const { event, receipt, windows } = input;
  const record = windows.get(event.windowId);
  const native = record?.host.readRuntimeWindowPlacement?.();
  const fingerprint = event.targetDisplay.fingerprint;
  if (
    !record || record.host.isDestroyed() || !native || !fingerprint ||
    receipt.status !== "applied" ||
    !["applied", "notRequired"].includes(receipt.persistenceStatus) ||
    !receipt.coreProjectionApplied || receipt.windowId !== event.windowId ||
    receipt.windowGeneration !== event.windowGeneration ||
    receipt.topologyRevision !== record.topologyRevision ||
    record.windowGeneration !== event.windowGeneration ||
    native.nativeHostId !== event.nativeHostId ||
    native.nativeGeneration !== event.nativeGeneration ||
    native.topologyRevision !== receipt.topologyRevision
  ) {
    throw new RionBridgeError({
      code: "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_TARGET_FENCE_STALE",
      message: "The Core placement receipt lost its exact Electron runtime target."
    });
  }
  record.hostTarget = Object.freeze({
    ...record.hostTarget,
    displayId: event.targetDisplay.id,
    scaleFactor: fingerprint.scaleFactor,
    workArea: Object.freeze({ ...event.placement.savedWorkArea }),
    bounds: Object.freeze({ ...event.placement.normalBounds }),
    presentation: event.placement.presentation
  });
}
