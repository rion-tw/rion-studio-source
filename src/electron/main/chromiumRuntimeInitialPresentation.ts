import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeWindowRecord } from "./chromiumRuntimeAppKitProjection";

/** Consumes the staged native mode only after exact Core visible admission. */
export async function completeChromiumRuntimeInitialPresentation(
  record: ChromiumRuntimeWindowRecord
): Promise<void> {
  if (!record.host.readPendingInitialPresentation?.()) return;
  if (!record.host.completeInitialPresentation) {
    throw new RionBridgeError({
      code: "ELECTRON_CHROMIUM_INITIAL_PRESENTATION_UNAVAILABLE",
      message: "The admitted visible host lost its initial presentation lane."
    });
  }
  await record.host.completeInitialPresentation({
    windowId: record.host.logicalWindowId,
    windowGeneration: record.windowGeneration,
    topologyRevision: record.topologyRevision
  });
}

export async function revealChromiumRuntimeRestoredWindow(
  record: ChromiumRuntimeWindowRecord
): Promise<void> {
  if (!record.host.isVisible()) record.host.showInactive!();
  if (!record.host.isVisible()) {
    throw new RionBridgeError({
      code: "ELECTRON_CHROMIUM_WINDOW_REVEAL_NOT_OBSERVED",
      message: "The loaded Chromium host did not acknowledge its exact native reveal."
    });
  }
  await completeChromiumRuntimeInitialPresentation(record);
}
