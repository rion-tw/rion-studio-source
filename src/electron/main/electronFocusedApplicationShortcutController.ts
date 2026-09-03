import type {
  AppKitRuntimeHostIdentityRecord,
  RuntimeWindowZoomReceiptRecord,
  SystemRuntimeOperationSummaryRecord
} from "../../shared/generated";
import type { ApplicationShortcutCommand } from "../../shared/types";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";

export interface ElectronFocusedShortcutWindowPort {
  readonly id: number;
  isDestroyed: () => boolean;
  isFullScreen: () => boolean;
  setFullScreen: (fullscreen: boolean) => void;
}

export interface ElectronFocusedRuntimeShortcutTarget {
  readonly activeTabId: string;
  readonly appKitIdentity?: AppKitRuntimeHostIdentityRecord;
  readonly parentNativeHostId: number;
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
}

export interface ElectronFocusedApplicationShortcutControllerInput {
  readonly platform: "darwin" | "win32";
  readonly executeMainWindowShortcut: (
    command: ApplicationShortcutCommand
  ) => Promise<void>;
  readonly readMainWindow: () => ElectronFocusedShortcutWindowPort;
  readonly readRuntimeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
  readonly requestMainWindowQuickAccess: () => void;
  readonly requestRuntimeTabQuickAccess: (tabId: string) => void;
  readonly toggleRuntimeWindowFullscreen: (
    target: ElectronFocusedRuntimeShortcutTarget
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  readonly zoomRuntimeWindow: (
    target: ElectronFocusedRuntimeShortcutTarget,
    action: "in" | "out" | "reset"
  ) => Promise<RuntimeWindowZoomReceiptRecord>;
}

function shortcutError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function runtimeZoomAction(
  command: Extract<
    ApplicationShortcutCommand,
    "zoomReset" | "zoomIn" | "zoomOut"
  >
): "in" | "out" | "reset" {
  if (command === "zoomIn") return "in";
  if (command === "zoomOut") return "out";
  return "reset";
}

function exactRuntimeTarget(
  input: ElectronFocusedApplicationShortcutControllerInput,
  focusedWindow: ElectronFocusedShortcutWindowPort
): ElectronFocusedRuntimeShortcutTarget {
  const matches = input.readRuntimeSnapshot().windows.filter((window) =>
    window.parentNativeHostId === focusedWindow.id
  );
  if (matches.length !== 1) {
    throw shortcutError(
      "ELECTRON_APPLICATION_SHORTCUT_TARGET_UNAVAILABLE",
      "The focused native window is not an exact Rion Studio runtime host."
    );
  }
  return exactRuntimeSnapshotTarget(input, matches[0]!);
}

function exactRuntimeSnapshotTarget(
  input: ElectronFocusedApplicationShortcutControllerInput,
  runtime: ChromiumRuntimeExecutorSnapshot["windows"][number]
): ElectronFocusedRuntimeShortcutTarget {
  const expectedAppKit = input.platform === "darwin";
  if (
    !runtime.focused || runtime.activeTabId.length === 0 ||
    !runtime.tabIds.includes(runtime.activeTabId) ||
    !Number.isSafeInteger(runtime.parentNativeHostId) ||
    (runtime.parentNativeHostId ?? 0) < 1 ||
    !Number.isSafeInteger(runtime.windowGeneration) ||
    runtime.windowGeneration < 1 ||
    !Number.isSafeInteger(runtime.topologyRevision) ||
    runtime.topologyRevision < 1 ||
    (runtime.appKitIdentity !== undefined) !== expectedAppKit ||
    (runtime.appKitIdentity !== undefined && (
      runtime.appKitIdentity.logicalWindowId !== runtime.windowId ||
      runtime.appKitIdentity.launchGeneration.length === 0 ||
      !Number.isSafeInteger(runtime.appKitIdentity.nativeGeneration) ||
      runtime.appKitIdentity.nativeGeneration < 1
    ))
  ) {
    throw shortcutError(
      "ELECTRON_APPLICATION_SHORTCUT_TARGET_STALE",
      "The focused runtime host lost its exact native and Core ownership fence."
    );
  }
  return Object.freeze({
    activeTabId: runtime.activeTabId,
    ...(runtime.appKitIdentity
      ? { appKitIdentity: Object.freeze({ ...runtime.appKitIdentity }) }
      : {}),
    parentNativeHostId: runtime.parentNativeHostId!,
    topologyRevision: runtime.topologyRevision,
    windowGeneration: runtime.windowGeneration,
    windowId: runtime.windowId
  });
}

function focusedAppKitRuntimeTarget(
  input: ElectronFocusedApplicationShortcutControllerInput
): ElectronFocusedRuntimeShortcutTarget | null {
  if (input.platform !== "darwin") return null;
  const matches = input.readRuntimeSnapshot().windows.filter((window) =>
    window.focused && window.appKitIdentity !== undefined
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw shortcutError(
      "ELECTRON_APPLICATION_SHORTCUT_TARGET_AMBIGUOUS",
      "AppKit reported more than one focused runtime shortcut target."
    );
  }
  return exactRuntimeSnapshotTarget(input, matches[0]!);
}

/**
 * Preserves the stable shell's focused-window semantics for native menu
 * accelerators. Renderer-issued commands remain explicitly main-window scoped.
 */
export class ElectronFocusedApplicationShortcutController {
  readonly #input: ElectronFocusedApplicationShortcutControllerInput;

  constructor(input: ElectronFocusedApplicationShortcutControllerInput) {
    this.#input = input;
  }

  executeQuickAccess(
    focusedWindow?: ElectronFocusedShortcutWindowPort
  ): void {
    const mainWindow = this.#input.readMainWindow();
    if (mainWindow.isDestroyed()) {
      throw shortcutError(
        "ELECTRON_APPLICATION_SHORTCUT_MAIN_WINDOW_STALE",
        "The Quick Access shortcut lost its exact main-window fallback."
      );
    }
    const appKitTarget = focusedWindow === undefined
      ? focusedAppKitRuntimeTarget(this.#input)
      : null;
    if (appKitTarget !== null) {
      this.#input.requestRuntimeTabQuickAccess(appKitTarget.activeTabId);
      return;
    }
    if (focusedWindow === undefined || focusedWindow.id === mainWindow.id) {
      this.#input.requestMainWindowQuickAccess();
      return;
    }
    if (focusedWindow.isDestroyed()) {
      throw shortcutError(
        "ELECTRON_APPLICATION_SHORTCUT_TARGET_STALE",
        "The focused Quick Access target was destroyed before admission."
      );
    }
    const target = exactRuntimeTarget(this.#input, focusedWindow);
    this.#input.requestRuntimeTabQuickAccess(target.activeTabId);
  }

  async execute(
    command: ApplicationShortcutCommand,
    focusedWindow?: ElectronFocusedShortcutWindowPort
  ): Promise<void> {
    if (command === "newGameWindow" || command === "quitApplication") {
      await this.#input.executeMainWindowShortcut(command);
      return;
    }
    const mainWindow = this.#input.readMainWindow();
    if (mainWindow.isDestroyed()) {
      throw shortcutError(
        "ELECTRON_APPLICATION_SHORTCUT_MAIN_WINDOW_STALE",
        "The application shortcut lost its exact main-window fallback."
      );
    }
    // Electron does not consistently supply its BaseWindow wrapper to an
    // application-menu callback when the retained AppKit NSWindow is key.
    // The live AppKit projection is therefore the authoritative fallback.
    const appKitTarget = focusedWindow === undefined
      ? focusedAppKitRuntimeTarget(this.#input)
      : null;
    if (appKitTarget !== null) {
      const receipt = command === "toggleFullscreen"
        ? await this.#input.toggleRuntimeWindowFullscreen(appKitTarget)
        : await this.#input.zoomRuntimeWindow(
            appKitTarget,
            runtimeZoomAction(command)
          );
      if (receipt.status !== "applied") {
        throw shortcutError(
          "ELECTRON_APPLICATION_SHORTCUT_RUNTIME_NOT_APPLIED",
          "Core did not terminalize the exact focused runtime shortcut as applied."
        );
      }
      return;
    }
    if (focusedWindow === undefined || focusedWindow.id === mainWindow.id) {
      await this.#input.executeMainWindowShortcut(command);
      return;
    }
    if (focusedWindow.isDestroyed()) {
      throw shortcutError(
        "ELECTRON_APPLICATION_SHORTCUT_TARGET_STALE",
        "The focused native shortcut target was destroyed before admission."
      );
    }
    const target = exactRuntimeTarget(this.#input, focusedWindow);
    if (command === "toggleFullscreen" && this.#input.platform === "darwin") {
      // A windowed retained AppKit host still has an exact Electron BaseWindow.
      // Start its visible native action there so the AppKit placement event is
      // authoritative. Once fullscreen rehosting hides that wrapper, the
      // focused-AppKit fallback above routes the exit through Core instead.
      focusedWindow.setFullScreen(!focusedWindow.isFullScreen());
      return;
    }
    const receipt = command === "toggleFullscreen"
      ? await this.#input.toggleRuntimeWindowFullscreen(target)
      : await this.#input.zoomRuntimeWindow(target, runtimeZoomAction(command));
    if (receipt.status !== "applied") {
      throw shortcutError(
        "ELECTRON_APPLICATION_SHORTCUT_RUNTIME_NOT_APPLIED",
        "Core did not terminalize the exact focused runtime shortcut as applied."
      );
    }
  }
}
