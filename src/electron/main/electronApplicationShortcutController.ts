import type { SystemRuntimeOperationSummaryRecord } from "../../shared/generated";
import type { ApplicationShortcutCommand } from "../../shared/types";
import { RionBridgeError } from "../ipc/errors";
import type { RendererIdentity } from "./rendererIdentity";

type MaybePromise<Value> = Value | Promise<Value>;

type FullscreenEvent = "closed" | "enter-full-screen" | "leave-full-screen";
type FullscreenListener = () => void;

export interface ElectronShortcutWebContentsPort {
  readonly id: number;
  getZoomFactor: () => number;
  isDestroyed: () => boolean;
  setZoomFactor: (factor: number) => void;
}

export interface ElectronShortcutMainWindowPort {
  readonly id: number;
  readonly webContents: ElectronShortcutWebContentsPort;
  isDestroyed: () => boolean;
  isFullScreen: () => boolean;
  on: (event: FullscreenEvent, listener: FullscreenListener) => unknown;
  removeListener: (event: FullscreenEvent, listener: FullscreenListener) => unknown;
  setFullScreen: (fullscreen: boolean) => void;
}

export interface ElectronApplicationShortcutControllerInput<
  Window extends ElectronShortcutMainWindowPort = ElectronShortcutMainWindowPort
> {
  /** Must resolve through RendererIdentityRegistry/currentWindow. */
  readonly resolveMainWindow: (identity: RendererIdentity) => Window;
  /** Must complete Core registration and one exact native empty-window readback. */
  readonly createNewGameWindow: (
    identity: RendererIdentity,
    window: Window
  ) => MaybePromise<void>;
  /** Must enter the existing renderer-confirmed application quit lifecycle. */
  readonly requestApplicationQuit: (
    identity: RendererIdentity,
    window: Window
  ) => MaybePromise<void>;
}

const MIN_ZOOM_FACTOR = 0.25;
const MAX_ZOOM_FACTOR = 5;
const ZOOM_STEP = 0.1;

function shortcutError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function nextZoomFactor(
  current: number,
  command: Extract<ApplicationShortcutCommand, "zoomReset" | "zoomIn" | "zoomOut">
): number {
  if (!Number.isFinite(current) || current < MIN_ZOOM_FACTOR || current > MAX_ZOOM_FACTOR) {
    throw shortcutError(
      "ELECTRON_MAIN_WINDOW_ZOOM_INVALID",
      "The exact main-window Chromium zoom factor is invalid."
    );
  }
  if (command === "zoomReset") return 1;
  const delta = command === "zoomIn" ? ZOOM_STEP : -ZOOM_STEP;
  const stepped = (Math.round(current * 100) + Math.round(delta * 100)) / 100;
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, stepped));
}

export class ElectronApplicationShortcutController<
  Window extends ElectronShortcutMainWindowPort = ElectronShortcutMainWindowPort
> {
  readonly #input: ElectronApplicationShortcutControllerInput<Window>;
  #lane: Promise<void> = Promise.resolve();
  #admissionGeneration = 0;
  #cancelActiveFullscreen: (() => void) | null = null;

  constructor(input: ElectronApplicationShortcutControllerInput<Window>) {
    this.#input = input;
  }

  async execute(
    identity: RendererIdentity,
    command: ApplicationShortcutCommand
  ): Promise<void> {
    if (command === "quitApplication") {
      this.#resolveExactMainWindow(identity);
      this.#admissionGeneration += 1;
      this.#cancelActiveFullscreen?.();
      return this.#executeOne(identity, command);
    }
    const admittedGeneration = this.#admissionGeneration;
    const operation = this.#lane
      .catch(() => undefined)
      .then(() => {
        if (admittedGeneration !== this.#admissionGeneration) {
          throw shortcutError(
            "ELECTRON_APPLICATION_SHORTCUT_SUPERSEDED",
            "The queued application shortcut was superseded by application quit."
          );
        }
        return this.#executeOne(identity, command);
      });
    this.#lane = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #executeOne(
    identity: RendererIdentity,
    command: ApplicationShortcutCommand
  ): Promise<void> {
    const window = this.#resolveExactMainWindow(identity);
    switch (command) {
      case "newGameWindow":
        await this.#input.createNewGameWindow(identity, window);
        return;
      case "quitApplication":
        await this.#input.requestApplicationQuit(identity, window);
        return;
      case "toggleFullscreen":
        await this.#toggleFullscreen(identity, window);
        return;
      case "zoomReset":
      case "zoomIn":
      case "zoomOut":
        this.#applyZoom(identity, window, command);
        return;
      default:
        throw shortcutError(
          "ELECTRON_APPLICATION_SHORTCUT_INVALID",
          "The application shortcut command is not supported."
        );
    }
  }

  startCurrentWindowDrag(
    identity: RendererIdentity
  ): SystemRuntimeOperationSummaryRecord {
    this.#resolveExactMainWindow(identity);
    throw shortcutError(
      "ELECTRON_NATIVE_WINDOW_DRAG_REGION_REQUIRED",
      "Electron window dragging is available only through the authenticated native non-client drag region."
    );
  }

  #applyZoom(
    identity: RendererIdentity,
    expectedWindow: Window,
    command: Extract<ApplicationShortcutCommand, "zoomReset" | "zoomIn" | "zoomOut">
  ): void {
    const window = this.#resolveExactMainWindow(identity, expectedWindow);
    const target = nextZoomFactor(window.webContents.getZoomFactor(), command);
    window.webContents.setZoomFactor(target);
    const observed = window.webContents.getZoomFactor();
    if (observed !== target) {
      throw shortcutError(
        "ELECTRON_MAIN_WINDOW_ZOOM_NOT_APPLIED",
        "Chromium did not apply the exact main-window zoom factor."
      );
    }
  }

  #toggleFullscreen(identity: RendererIdentity, expectedWindow: Window): Promise<void> {
    const window = this.#resolveExactMainWindow(identity, expectedWindow);
    const target = !window.isFullScreen();
    const targetEvent = target ? "enter-full-screen" : "leave-full-screen";
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cancel = () => finish(() => reject(shortcutError(
        "ELECTRON_MAIN_WINDOW_FULLSCREEN_CANCELLED",
        "The main-window fullscreen transition was cancelled by application quit."
      )));
      const cleanup = () => {
        window.removeListener(targetEvent, onTargetState);
        window.removeListener("closed", onClosed);
        if (this.#cancelActiveFullscreen === cancel) {
          this.#cancelActiveFullscreen = null;
        }
      };
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const onClosed = () => finish(() => reject(shortcutError(
        "ELECTRON_MAIN_WINDOW_RETIRED",
        "The exact main window retired before the fullscreen transition completed."
      )));
      const onTargetState = () => finish(() => {
        try {
          const current = this.#resolveExactMainWindow(identity, expectedWindow);
          if (current.isFullScreen() !== target) {
            throw shortcutError(
              "ELECTRON_MAIN_WINDOW_FULLSCREEN_EVENT_INVALID",
              "Electron emitted a fullscreen event without the requested exact state."
            );
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      window.on(targetEvent, onTargetState);
      window.on("closed", onClosed);
      this.#cancelActiveFullscreen = cancel;
      try {
        window.setFullScreen(target);
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  #resolveExactMainWindow(
    identity: RendererIdentity,
    expectedWindow?: Window
  ): Window {
    const window = this.#input.resolveMainWindow(identity);
    if (
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.id !== identity.windowId ||
      window.webContents.id !== identity.webContentsId ||
      (expectedWindow !== undefined && window !== expectedWindow)
    ) {
      throw shortcutError(
        "ELECTRON_IPC_UNAUTHORIZED_SENDER",
        "The desktop request did not come from the exact active Rion Studio window."
      );
    }
    return window;
  }
}
