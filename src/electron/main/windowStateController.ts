import type { NativeWindowStateRecord } from "../../shared/generated";

export type ElectronWindowStateEvent =
  | "blur"
  | "enter-full-screen"
  | "focus"
  | "hide"
  | "leave-full-screen"
  | "maximize"
  | "minimize"
  | "restore"
  | "show"
  | "unmaximize";

type WindowStateListener = () => void;

export interface ElectronWindowStatePort {
  isFocused: () => boolean;
  isFullScreen: () => boolean;
  isMaximized: () => boolean;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  on: (event: ElectronWindowStateEvent, listener: WindowStateListener) => unknown;
  removeListener: (event: ElectronWindowStateEvent, listener: WindowStateListener) => unknown;
}

export interface ElectronWindowStateControllerInput {
  window: ElectronWindowStatePort;
  windowGeneration: number;
  lifecycleEpoch: () => number;
  publish: (state: NativeWindowStateRecord) => void;
  now?: () => string;
}

const WINDOW_STATE_EVENTS: readonly ElectronWindowStateEvent[] = [
  "blur",
  "enter-full-screen",
  "focus",
  "hide",
  "leave-full-screen",
  "maximize",
  "minimize",
  "restore",
  "show",
  "unmaximize"
];

interface SemanticWindowState {
  visible: boolean;
  minimized: boolean;
  maximized: boolean;
  fullscreen: boolean;
  focused: boolean;
}

function sameSemanticState(
  left: SemanticWindowState,
  right: SemanticWindowState
): boolean {
  return left.visible === right.visible &&
    left.minimized === right.minimized &&
    left.maximized === right.maximized &&
    left.fullscreen === right.fullscreen &&
    left.focused === right.focused;
}

export class ElectronWindowStateController {
  readonly #input: ElectronWindowStateControllerInput;
  #current: NativeWindowStateRecord | null = null;
  #started = false;

  constructor(input: ElectronWindowStateControllerInput) {
    this.#input = input;
  }

  start(): NativeWindowStateRecord {
    if (!this.#started) {
      this.#started = true;
      for (const event of WINDOW_STATE_EVENTS) {
        this.#input.window.on(event, this.#refreshAndPublish);
      }
    }
    return this.snapshot();
  }

  snapshot(): NativeWindowStateRecord {
    const semantic = this.#captureSemanticState();
    const lifecycleEpoch = this.#input.lifecycleEpoch();
    if (
      this.#current &&
      this.#current.lifecycleEpoch === lifecycleEpoch &&
      sameSemanticState(this.#current, semantic)
    ) {
      return this.#current;
    }
    const next: NativeWindowStateRecord = {
      revision: (this.#current?.revision ?? 0) + 1,
      capturedAt: (this.#input.now ?? (() => new Date().toISOString()))(),
      windowId: "main",
      windowGeneration: this.#input.windowGeneration,
      lifecycleEpoch,
      ...semantic
    };
    this.#current = next;
    return next;
  }

  dispose(): void {
    if (!this.#started) return;
    this.#started = false;
    for (const event of WINDOW_STATE_EVENTS) {
      this.#input.window.removeListener(event, this.#refreshAndPublish);
    }
  }

  readonly #refreshAndPublish = (): void => {
    const previousRevision = this.#current?.revision ?? 0;
    const next = this.snapshot();
    if (next.revision > previousRevision) this.#input.publish(next);
  };

  #captureSemanticState(): SemanticWindowState {
    return {
      visible: this.#input.window.isVisible(),
      minimized: this.#input.window.isMinimized(),
      maximized: this.#input.window.isMaximized(),
      fullscreen: this.#input.window.isFullScreen(),
      focused: this.#input.window.isFocused()
    };
  }
}
