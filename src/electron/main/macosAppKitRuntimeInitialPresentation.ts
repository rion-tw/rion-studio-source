import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeWindowPresentationRequest } from "./chromiumRuntimeFullscreenToolbar";
import type { MacosAppKitRuntimeHostRecord } from "./macosAppKitRuntimeHostRecord";

type InitialRequest = Pick<ChromiumRuntimeWindowPresentationRequest,
  "windowId" | "windowGeneration" | "topologyRevision">;

/** Native mode is submitted only after the exact Core visible admission. */
export async function completeMacosAppKitRuntimeInitialPresentation(input: Readonly<{
  record: MacosAppKitRuntimeHostRecord;
  request: InitialRequest;
  requireCurrent: () => void;
  refreshNormalBounds: () => void;
  refreshLayout: () => void;
  publishLayout: () => void;
  publishPlacement: () => void;
}>): Promise<void> {
  const { record, request } = input;
  const presentation = record.pendingInitialPresentation;
  const identity = Object.freeze({ ...record.identity });
  const controller = record.controller;
  const nativeHandle = record.nativeHandle;
  const requireFence = (): void => {
    input.requireCurrent();
    if (request.windowId !== identity.logicalWindowId ||
        !Number.isSafeInteger(request.windowGeneration) || request.windowGeneration < 1 ||
        !Number.isSafeInteger(request.topologyRevision) || request.topologyRevision < 1 ||
        request.windowGeneration !== record.windowGeneration ||
        request.topologyRevision !== record.topologyRevision ||
        record.pendingInitialPresentation !== presentation ||
        !record.presentationGate.admitted || record.state !== "active" ||
        !controller || record.controller !== controller ||
        controller.logicalWindowId !== identity.logicalWindowId ||
        controller.launchGeneration !== identity.launchGeneration ||
        controller.nativeGeneration !== identity.nativeGeneration ||
        record.identity.logicalWindowId !== identity.logicalWindowId ||
        record.identity.launchGeneration !== identity.launchGeneration ||
        record.identity.nativeGeneration !== identity.nativeGeneration ||
        !nativeHandle || !record.native.getNativeWindowHandle().equals(nativeHandle) ||
        record.native.isDestroyed() || !record.native.isVisible() || record.native.isMinimized()) {
      throw new RionBridgeError({ code: "ELECTRON_MACOS_APPKIT_INITIAL_PRESENTATION_FENCE_STALE",
        message: "Initial AppKit presentation lost its exact visible Core and native host." });
    }
  };
  requireFence();
  if (!presentation) return;
  const requestedNormalBounds = { ...record.normalBounds };
  // Attachment may already have fitted the hidden normal host. Retain that
  // actual geometry before fullscreen/maximize makes its viewport unavailable.
  input.refreshNormalBounds();
  requireFence();
  const fitted = (["x", "y", "width", "height"] as const).some(
    key => record.normalBounds[key] !== requestedNormalBounds[key]
  );
  const projection = await record.presentation.setInitialPresentation(
    { ...request, presentation },
    () => {
      requireFence();
      // This fresh native layout read belongs to the matching placement ACK.
      // Provisional normal/transition observations remain suppressed meanwhile.
      input.refreshLayout();
      requireFence();
      return record.host.readProjection();
    },
    requireFence
  );
  requireFence();
  const actual = record.host.readProjection();
  if (projection.presentation !== presentation || actual.presentation !== presentation ||
      !actual.visible || !projection.visible) {
    throw new RionBridgeError({ code: "ELECTRON_MACOS_APPKIT_INITIAL_PRESENTATION_READBACK_STALE",
      message: "Initial AppKit presentation lost its acknowledged native mode." });
  }
  // Publish only the acknowledged mode. A synchronous failure retains staging
  // and rejects the owning transaction rather than claiming completion.
  input.publishLayout();
  requireFence();
  // The same exact native mode ACK owns this fit receipt. Never publish the
  // provisional normal mode over Core's staged fullscreen/maximized target.
  if (fitted) input.publishPlacement();
  requireFence();
  record.pendingInitialPresentation = null;
}
