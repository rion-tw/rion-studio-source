import type { ChromiumRoleOverlayFrameIdentity } from
  "./chromiumRoleSurfaceRegistry";
import type {
  ChromiumNativeTrustedInputReceipt,
  ChromiumNativeTrustedInputRequest
} from "./chromiumTrustedInputCoordinator";

export const WINDOWS_CHROMIUM_TRUSTED_INPUT_ABI_VERSION = 3;

export type WindowsChromiumInputDeliveryMode = "foreground" | "background";

export const WINDOWS_CHROMIUM_TRUSTED_KEY_CODES = Object.freeze([
  "Backquote", "Backspace", "Tab", "Escape", "Insert", "Home", "PageUp",
  "Delete", "End", "PageDown", "ArrowLeft", "ArrowUp", "ArrowRight",
  "ArrowDown", "Equal", "Minus", "Space", "Backslash", "Slash", "Period",
  "Comma", "Semicolon", "Quote", "BracketLeft", "BracketRight", "Enter",
  "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7",
  "Digit8", "Digit9", "Digit0", "KeyA", "KeyB", "KeyC", "KeyD", "KeyE",
  "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK", "KeyL", "KeyM",
  "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU",
  "KeyV", "KeyW", "KeyX", "KeyY", "KeyZ", "F1", "F2", "F3", "F4",
  "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14",
  "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23",
  "F24"
] as const);

export interface WindowsChromiumInputSurfaceIdentity {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly nativeGeneration: number;
  /** Monotonic owner-issued revision for one exact HWND attachment. */
  readonly bindingRevision: string;
  /** Opaque native tokens; never renderer-visible HWND values. */
  readonly surfaceHandleToken: string;
  readonly parentHandleToken: string;
}

/**
 * Read-only evidence for a dedicated per-surface Electron BaseWindow HWND.
 *
 * Electron 43 exposes a native handle for BaseWindow/BrowserWindow, but not
 * for WebContentsView. A Windows implementation therefore may produce this
 * receipt only for a separately owned child host containing exactly one role
 * WebContentsView. Enumerating or guessing Chromium child HWNDs is forbidden.
 */
export interface WindowsChromiumInputSurfaceProbeReceipt
  extends WindowsChromiumInputSurfaceIdentity {
  readonly status: "verified";
  readonly abiVersion: 3;
  readonly deliveryMode: WindowsChromiumInputDeliveryMode;
  readonly probeRevision: string;
  readonly processId: number;
  readonly uiThreadId: number;
  readonly currentProcessOwned: true;
  readonly exactParent: true;
  readonly childWindowStyle: true;
  readonly popupWindowStyleAbsent: true;
  readonly noActivateStyle: true;
  readonly parentWasForeground: true;
  readonly parentVisible: true;
  readonly surfaceVisible: boolean;
  readonly targetWasForeground: boolean;
  readonly targetHadThreadFocus: boolean;
  readonly singleWebContentsSurface: true;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly dpi: number;
}

export interface WindowsNativeTrustedInputSubmissionBase
  extends WindowsChromiumInputSurfaceIdentity {
  readonly status: "submitted";
  readonly requestId: string;
  readonly inputEpoch: string;
  readonly deliveryMode: WindowsChromiumInputDeliveryMode;
  readonly dispatchSequence: string;
  readonly probeRevision: string;
  readonly submittedAtMs: string;
  readonly withinDeadline: true;
  readonly currentProcessOwned: true;
  readonly exactParent: true;
  readonly childWindowStyle: true;
  readonly popupWindowStyleAbsent: true;
  readonly noActivateStyle: true;
  readonly targetAttached: true;
  readonly noActivationApiCalled: true;
  readonly foregroundWindowPreserved: true;
  readonly activeWindowPreserved: true;
  readonly focusWindowPreserved: true;
  readonly parentWasForeground: true;
  readonly parentVisible: true;
  readonly surfaceVisible: boolean;
  readonly targetWasForeground: boolean;
  readonly targetHadThreadFocus: boolean;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly dpi: number;
}

export interface WindowsNativeTrustedKeyRequest {
  readonly requestId: string;
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly inputEpoch: string;
  readonly deadlineMs: string;
  readonly deliveryMode: WindowsChromiumInputDeliveryMode;
  readonly eventType: "keyDown" | "keyUp";
  readonly code: string;
  /** Win32: primary maps to Ctrl, unlike the retained macOS adapter. */
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly repeat: false;
}

export interface WindowsNativeTrustedKeySubmissionReceipt
  extends WindowsNativeTrustedInputSubmissionBase {
  readonly eventType: "keyDown" | "keyUp";
  readonly code: string;
  readonly virtualKeyCode: number;
  readonly scanCode: number;
  readonly extendedKey: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly keyboardStateRestored: true;
  readonly dispatchedEventCount: 1;
}

export interface WindowsNativeTrustedMouseRequest {
  readonly requestId: string;
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly inputEpoch: string;
  readonly deadlineMs: string;
  readonly deliveryMode: WindowsChromiumInputDeliveryMode;
  readonly clientX: number;
  readonly clientY: number;
  readonly zoomFactor: number;
  readonly button: 0 | 1 | 2;
}

export interface WindowsNativeTrustedMouseSubmissionReceipt
  extends WindowsNativeTrustedInputSubmissionBase {
  readonly button: 0 | 1 | 2;
  readonly clientX: number;
  readonly clientY: number;
  readonly zoomFactor: number;
  readonly nativeClientX: number;
  readonly nativeClientY: number;
  /** Coordinate expected back from Chromium after native pixel conversion. */
  readonly expectedDomClientX: number;
  readonly expectedDomClientY: number;
  readonly dispatchedEventCount: 2;
}

export interface RawNativeWindowsChromiumTrustedInputHost {
  focusForeground: (
    expected: WindowsChromiumInputSurfaceIdentity,
    request: ChromiumNativeTrustedInputRequest
  ) => Promise<ChromiumNativeTrustedInputReceipt>;
  currentInputDeliveryMode: (
    expected: WindowsChromiumInputSurfaceIdentity
  ) => WindowsChromiumInputDeliveryMode | null;
  isInputReady: (
    expected: WindowsChromiumInputSurfaceIdentity,
    deliveryMode: WindowsChromiumInputDeliveryMode
  ) => boolean;
  probeExactInputSurface: (
    expected: WindowsChromiumInputSurfaceIdentity,
    deliveryMode: WindowsChromiumInputDeliveryMode
  ) => WindowsChromiumInputSurfaceProbeReceipt;
  submitNativeBackgroundKey: (
    expected: WindowsChromiumInputSurfaceIdentity,
    request: WindowsNativeTrustedKeyRequest
  ) => WindowsNativeTrustedKeySubmissionReceipt;
  submitNativeBackgroundMouse: (
    expected: WindowsChromiumInputSurfaceIdentity,
    request: WindowsNativeTrustedMouseRequest
  ) => WindowsNativeTrustedMouseSubmissionReceipt;
}

export interface WindowsChromiumTrustedInputHostBinding {
  readonly identity: WindowsChromiumInputSurfaceIdentity;
  readonly native: RawNativeWindowsChromiumTrustedInputHost;
}

export interface WindowsChromiumTrustedInputHostPort {
  resolve: (
    roleId: string,
    generation: number
  ) => WindowsChromiumTrustedInputHostBinding | null;
}

export interface WindowsChromiumTrustedInputSurfacePort {
  authorizeTrustedInputFrame: (
    sender: unknown,
    senderFrame: unknown,
    claimedFrameToken: unknown
  ) => ChromiumRoleOverlayFrameIdentity;
  currentTrustedInputFrame: (
    roleId: string,
    generation: number
  ) => ChromiumRoleOverlayFrameIdentity;
  sendTrustedInputControl: (
    expected: ChromiumRoleOverlayFrameIdentity,
    control: import("../ipc/chromiumRoleTrustedInputProtocol")
      .ChromiumRoleTrustedInputControlEnvelope
  ) => void;
  subscribeTrustedInputLifecycle: (
    listener: (
      event: import("./chromiumRoleSurfaceRegistry")
        .ChromiumRoleOverlayLifecycleEvent
    ) => void
  ) => () => void;
}

export interface WindowsChromiumTrustedInputClickResolverPort {
  resolve: (
    request: ChromiumNativeTrustedInputRequest,
    frame: ChromiumRoleOverlayFrameIdentity
  ) => Readonly<{ clientX: number; clientY: number; zoomFactor: number }>;
}
