import type { MacroKeyInput } from "../../../shared/macroKeys";
import type { MacroClickAnchor, MacroClickUnit } from "../../../shared/types";

/**
 * Engine-neutral automation semantics required by the Rust macro runtime.
 *
 * Native adapters may use CDP, WebView2 APIs, WebKit automation SPI, or another
 * trusted input mechanism internally. Callers must not depend on that transport.
 */
export interface AutomationTargetPort {
  dispose: () => Promise<void>;
  dispatchClick: (
    xPercent: number,
    yPercent: number,
    options?: AutomationInputDispatchOptions
  ) => Promise<void>;
  dispatchClickPixels?: (
    xPx: number,
    yPx: number,
    options?: AutomationInputDispatchOptions
  ) => Promise<void>;
  dispatchClickAnchored?: (
    anchor: MacroClickAnchor | undefined,
    unit: MacroClickUnit,
    x: number,
    y: number,
    options?: AutomationInputDispatchOptions
  ) => Promise<void>;
  dispatchKey: (
    input: MacroKeyInput | string,
    options?: AutomationInputDispatchOptions
  ) => Promise<void>;
  holdKey: (
    input: MacroKeyInput | string,
    ownerId: string,
    options?: AutomationInputDispatchOptions
  ) => Promise<void>;
  releaseKey: (input: MacroKeyInput | string, ownerId: string) => Promise<void>;
  ensureInputFocus: () => Promise<boolean>;
  evaluate: <T = unknown>(source: string) => Promise<T>;
  focus: () => Promise<void>;
}

export interface AutomationInputDispatchOptions {
  holdMs?: number;
  onClick?: () => void;
  postDelayMs?: number;
  signal?: AbortSignal;
  waitForDelay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
