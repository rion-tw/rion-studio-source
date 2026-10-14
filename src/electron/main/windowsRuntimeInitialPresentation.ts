import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeWindowPresentationRequest } from "./chromiumRuntimeFullscreenToolbar";
import type {
  WindowsRuntimeHostWindowPort,
  WindowsRuntimeInactivePresentationPort
} from "./windowsRuntimeHostNativePorts";
import type { WindowsRuntimeForegroundReadback } from "./windowsRuntimeWindowState";
import type { WindowsRuntimeHostChromeController } from "./windowsRuntimeHostChromeController";

export type WindowsRuntimeInitialPresentationMode = "maximized" | "fullscreen";

interface InitialPresentationInput {
  readonly native: WindowsRuntimeHostWindowPort;
  readonly nativeHandle: Buffer;
  readonly port: WindowsRuntimeInactivePresentationPort | null;
  readonly windowId: string;
  readonly chrome: WindowsRuntimeHostChromeController;
  readonly captureBeforeFullscreen: () => void;
  readonly requireCurrent: () => void;
  readonly readPending: () => WindowsRuntimeInitialPresentationMode | null;
  readonly clearPending: () => void;
}

function requireNativeReadback(value: WindowsRuntimeForegroundReadback): void {
  if (!value || !/^[0-9a-f]{64}$/u.test(value.parentIdentity) ||
      !/^[0-9a-f]{64}$/u.test(value.focusIdentity) ||
      typeof value.parentWasForeground !== "boolean" ||
      typeof value.parentVisible !== "boolean" ||
      typeof value.parentMinimized !== "boolean") {
    throw new RionBridgeError({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_READBACK_STALE",
      message: "The initial presentation lost its exact native parent readback." });
  }
}

function requireInitialFence(
  input: InitialPresentationInput,
  request: Pick<ChromiumRuntimeWindowPresentationRequest, "windowId" | "windowGeneration" | "topologyRevision">,
  afterAcknowledgement = false
): void {
  input.requireCurrent();
  const current = input.chrome.readCoreFence();
  if (request.windowId !== input.windowId ||
      !Number.isSafeInteger(request.windowGeneration) || request.windowGeneration < 1 ||
      !Number.isSafeInteger(request.topologyRevision) || request.topologyRevision < 1 ||
      current.windowGeneration !== request.windowGeneration ||
      current.topologyRevision !== request.topologyRevision) {
    throw new RionBridgeError({ code: afterAcknowledgement
      ? "ELECTRON_RUNTIME_INITIAL_PRESENTATION_SUPERSEDED"
      : "ELECTRON_RUNTIME_INITIAL_PRESENTATION_FENCE_STALE",
    message: "Initial presentation lost its exact Core-owned host fence." });
  }
  if (input.native.isDestroyed() || !input.native.isVisible() || input.native.isMinimized() ||
      !input.native.getNativeWindowHandle().equals(input.nativeHandle)) {
    throw new RionBridgeError({ code: afterAcknowledgement
      ? "ELECTRON_RUNTIME_INITIAL_PRESENTATION_READBACK_STALE"
      : "ELECTRON_RUNTIME_INITIAL_PRESENTATION_FENCE_STALE",
    message: "Initial presentation lost its exact visible Windows handle." });
  }
}

function prepareInitialFullscreen(
  input: InitialPresentationInput,
  request: ChromiumRuntimeWindowPresentationRequest
): Readonly<{
  submit: (mutation: ChromiumRuntimeWindowPresentationRequest, submitForeground: () => void) => void;
  confirm: () => void;
}> {
  requireInitialFence(input, request);
  const port = input.port;
  if (!port) {
    throw new RionBridgeError({ code: "ELECTRON_RUNTIME_INACTIVE_PRESENTATION_UNAVAILABLE",
      message: "The exact Windows inactive presentation lane is unavailable." });
  }
  const before = port.readWindowsRuntimeForeground(input.nativeHandle);
  requireNativeReadback(before);
  if (!before.parentVisible || before.parentMinimized) {
    throw new RionBridgeError({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_READBACK_STALE",
      message: "Initial fullscreen lost its visible native parent." });
  }
  const submit = (mutation: ChromiumRuntimeWindowPresentationRequest, submitForeground: () => void): void => {
    requireInitialFence(input, mutation);
    if (mutation.presentation !== "fullscreen" || mutation.windowGeneration !== request.windowGeneration ||
        mutation.topologyRevision !== request.topologyRevision) {
      throw new RionBridgeError({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_FENCE_STALE",
        message: "Initial fullscreen lost its exact native submission request." });
    }
    // The exact Core focus admission may use the normal native setter. A
    // background host never invokes its foreground focus-preservation branch.
    if (before.parentWasForeground) submitForeground();
    else {
      input.captureBeforeFullscreen();
      requireInitialFence(input, mutation);
      input.native.setFullScreen(true);
    }
  };
  const confirm = (): void => {
    const after = port.readWindowsRuntimeForeground(input.nativeHandle);
    requireNativeReadback(after);
    if (after.parentIdentity !== before.parentIdentity || !after.parentVisible || after.parentMinimized ||
        (!before.parentWasForeground && (after.parentWasForeground || after.focusIdentity !== before.focusIdentity))) {
      throw new RionBridgeError({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_READBACK_STALE",
        message: "Initial background fullscreen changed its native parent or focus identity." });
    }
  };
  return { submit, confirm };
}

/** Creation stages a mode; only the exact visible admission consumes it. */
export async function completeWindowsRuntimeInitialPresentation(
  input: InitialPresentationInput,
  request: Pick<ChromiumRuntimeWindowPresentationRequest, "windowId" | "windowGeneration" | "topologyRevision">
): Promise<void> {
  requireInitialFence(input, request);
  const presentation = input.readPending();
  if (!presentation) return;
  const owned: InitialPresentationInput = { ...input, requireCurrent: () => {
    input.requireCurrent();
    if (input.readPending() !== presentation) {
      throw new RionBridgeError({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_SUPERSEDED",
        message: "A newer presentation superseded the initial native mutation." });
    }
  } };
  const fullscreen = presentation === "fullscreen"
    ? prepareInitialFullscreen(owned, { ...request, presentation }) : undefined;
  await input.chrome.setPresentation({ ...request, presentation }, (mutation, submitForeground) => {
    owned.requireCurrent();
    if (presentation === "maximized") {
      maximizeWindowsRuntimeInitialPresentation({
        ...owned, request: mutation, readCoreFence: () => input.chrome.readCoreFence()
      });
    } else fullscreen!.submit(mutation, submitForeground);
  });
  requireInitialFence(input, request, true);
  fullscreen?.confirm();
  requireInitialFence(input, request, true);
  if (input.readPending() !== presentation ||
      (presentation === "fullscreen" ? !input.native.isFullScreen() : !input.native.isMaximized())) {
    throw new RionBridgeError({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_READBACK_STALE",
      message: "The initial presentation acknowledgement lost its exact native mode." });
  }
  input.clearPending();
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
