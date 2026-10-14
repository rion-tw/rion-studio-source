import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeWindowPresentationRequest } from "./chromiumRuntimeFullscreenToolbar";
import type {
  WindowsRuntimeHostWindowPort,
  WindowsRuntimeInactivePresentationPort
} from "./windowsRuntimeHostNativePorts";
import type { WindowsRuntimeForegroundReadback } from "./windowsRuntimeWindowState";

function requireNativeReadback(value: WindowsRuntimeForegroundReadback): void {
  if (!value || !/^[0-9a-f]{64}$/u.test(value.parentIdentity) ||
      !/^[0-9a-f]{64}$/u.test(value.focusIdentity) ||
      typeof value.parentWasForeground !== "boolean" ||
      typeof value.parentVisible !== "boolean" ||
      typeof value.parentMinimized !== "boolean") {
    throw new RionBridgeError({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_READBACK_STALE",
      message: "The initial maximize lost its exact native parent readback." });
  }
}

/** Submits once under the exact Core fence; the chrome owner awaits native layout. */
export function maximizeWindowsRuntimeInitialPresentation(input: Readonly<{
  native: WindowsRuntimeHostWindowPort;
  nativeHandle: ReturnType<WindowsRuntimeHostWindowPort["getNativeWindowHandle"]>;
  port: WindowsRuntimeInactivePresentationPort | null;
  request: ChromiumRuntimeWindowPresentationRequest;
  windowId: string;
  readCoreFence: () => Readonly<{ windowGeneration: number; topologyRevision: number }>;
  requireCurrent: () => void;
}>): void {
  const { request, native, port } = input;
  const requireFence = (): void => {
    input.requireCurrent();
    const fence = input.readCoreFence();
    if (request.windowId !== input.windowId || request.presentation !== "maximized" ||
        !Number.isSafeInteger(request.windowGeneration) || request.windowGeneration < 1 ||
        !Number.isSafeInteger(request.topologyRevision) || request.topologyRevision < 1 ||
        request.windowGeneration !== fence.windowGeneration ||
        request.topologyRevision !== fence.topologyRevision ||
        native.isDestroyed() || !native.isVisible() || native.isMinimized() ||
        !native.getNativeWindowHandle().equals(input.nativeHandle)) {
      throw new RionBridgeError({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_FENCE_STALE",
        message: "Initial maximize requires the exact visible Core-owned host." });
    }
  };
  requireFence();
  if (!port) {
    throw new RionBridgeError({ code: "ELECTRON_RUNTIME_INACTIVE_PRESENTATION_UNAVAILABLE",
      message: "The exact Windows inactive presentation lane is unavailable." });
  }
  const handle = input.nativeHandle;
  const before = port.readWindowsRuntimeForeground(handle);
  requireNativeReadback(before);
  if (!before.parentVisible || before.parentMinimized) {
    throw new RionBridgeError({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_READBACK_STALE",
      message: "The initial maximize lost its visible native parent." });
  }
  requireFence();
  if (before.parentWasForeground) {
    native.maximize();
    return;
  }
  const after = port.maximizeWindowsRuntimeParentInactive(handle, before.parentIdentity);
  requireNativeReadback(after);
  if (after.parentIdentity !== before.parentIdentity || after.focusIdentity !== before.focusIdentity ||
      after.parentWasForeground || !after.parentVisible || after.parentMinimized) {
    throw new RionBridgeError({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_READBACK_STALE",
      message: "The initial background maximize changed its native parent or focus identity." });
  }
}
