import type {
  EmbeddedKeyEffectRecord,
  EmbeddedKeyTransitionRecord
} from "../../shared/generated";
import { resolveMacroClickOffset } from "../../shared/macroCoordinates";
import {
  resolveMacroKeyInput,
  type MacroKeyInput
} from "../../shared/macroKeys";
import type { MacroClickAnchor, MacroClickUnit } from "../../shared/types";
import type { EmbeddedKeyRuntimeClient } from "../core/nativeCore";
import { getCdpKeyDescriptor, getCdpModifierMask } from "./CdpInput";
import { createFocusSource, waitForInputDelay } from "./ElectronAutomationTarget";
import type {
  AutomationInputDispatchOptions,
  AutomationTargetPort
} from "./ports/AutomationTargetPort";
import type { WindowsWebView2SurfacePort } from "./WindowsWebView2Surface";

interface LayoutMetrics {
  cssVisualViewport?: { clientHeight?: number; clientWidth?: number };
  layoutViewport?: { clientHeight?: number; clientWidth?: number };
}

/**
 * Trusted Windows input adapter. WebView2 exposes CDP per control without a
 * loopback debugging port, while Rust remains authoritative for held-key
 * ownership and transition compensation.
 */
export class WebView2AutomationTarget implements AutomationTargetPort {
  private readonly activeCodes = new Set<string>();
  private readonly lifecycle = new AbortController();
  private inputLane: Promise<void> = Promise.resolve();
  private disposed = false;
  private transientOwnerSequence = 0;

  constructor(
    private readonly surface: WindowsWebView2SurfacePort,
    private readonly keyRuntime: EmbeddedKeyRuntimeClient,
    private readonly roleId: string
  ) {}

  dispatchClick(
    xPercent: number,
    yPercent: number,
    options: AutomationInputDispatchOptions = {}
  ): Promise<void> {
    return this.enqueue(async () => {
      const viewport = await this.getViewport();
      await this.clickAt(
        Math.round((viewport.width * xPercent) / 100),
        Math.round((viewport.height * yPercent) / 100),
        viewport,
        this.withLifecycleSignal(options)
      );
    });
  }

  dispatchClickPixels(
    xPx: number,
    yPx: number,
    options: AutomationInputDispatchOptions = {}
  ): Promise<void> {
    return this.enqueue(async () => {
      const viewport = await this.getViewport();
      await this.clickAt(xPx, yPx, viewport, this.withLifecycleSignal(options));
    });
  }

  dispatchClickAnchored(
    anchor: MacroClickAnchor | undefined,
    unit: MacroClickUnit,
    x: number,
    y: number,
    options: AutomationInputDispatchOptions = {}
  ): Promise<void> {
    return this.enqueue(async () => {
      const viewport = await this.getViewport();
      const resolved = resolveMacroClickOffset({ anchor, unit, x, y }, viewport);
      await this.clickAt(
        unit === "percent" ? (viewport.width * resolved.x) / 100 : resolved.x,
        unit === "percent" ? (viewport.height * resolved.y) / 100 : resolved.y,
        viewport,
        this.withLifecycleSignal(options)
      );
    });
  }

  dispatchKey(
    input: MacroKeyInput | string,
    options: AutomationInputDispatchOptions = {}
  ): Promise<void> {
    return this.enqueue(async () => {
      const normalized = toMacroKeyInput(input);
      const { code, modifierCodes } = resolveMacroKeyInput(normalized, "win32");
      const ownerId = `webview2-tap:${this.roleId}:${++this.transientOwnerSequence}`;
      const signal = this.withLifecycleSignal(options).signal;
      if ((options.holdMs ?? 0) <= 0) {
        await this.executePreparedTransition("tap", code, modifierCodes, ownerId, signal);
      } else {
        await this.executePreparedTransition("hold", code, modifierCodes, ownerId, signal);
        try {
          await (options.waitForDelay ?? waitForInputDelay)(options.holdMs ?? 0, signal);
        } finally {
          await this.executePreparedTransition("release", code, modifierCodes, ownerId);
        }
      }
      await (options.waitForDelay ?? waitForInputDelay)(options.postDelayMs ?? 0, signal);
    });
  }

  holdKey(
    input: MacroKeyInput | string,
    ownerId: string,
    options: AutomationInputDispatchOptions = {}
  ): Promise<void> {
    return this.enqueue(async () => {
      const { code, modifierCodes } = resolveMacroKeyInput(toMacroKeyInput(input), "win32");
      const signal = this.withLifecycleSignal(options).signal;
      await this.executePreparedTransition("hold", code, modifierCodes, ownerId, signal);
      await (options.waitForDelay ?? waitForInputDelay)(options.postDelayMs ?? 0, signal);
    });
  }

  releaseKey(input: MacroKeyInput | string, ownerId: string): Promise<void> {
    return this.enqueue(async () => {
      const { code, modifierCodes } = resolveMacroKeyInput(toMacroKeyInput(input), "win32");
      await this.executePreparedTransition("release", code, modifierCodes, ownerId);
    });
  }

  async ensureInputFocus(): Promise<boolean> {
    return this.enqueue(async () => {
      const result = await this.surface.evaluate<string>(createFocusSource(true)).catch(() => "");
      return result === "canvas" || result === "iframe" || result === "body";
    });
  }

  evaluate<T = unknown>(source: string): Promise<T> {
    return this.enqueue(() => this.surface.evaluate<T>(source));
  }

  focus(): Promise<void> {
    return this.enqueue(() => this.surface.focus());
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.inputLane;
    this.disposed = true;
    this.lifecycle.abort(new Error("WebView2 automation target disposed."));
    return this.inputLane.catch(() => undefined).then(async () => {
      const remaining = new Set(this.activeCodes);
      for (const code of [...remaining].reverse()) {
        remaining.delete(code);
        await this.sendKey("keyUp", code, remaining).catch(() => undefined);
      }
      this.activeCodes.clear();
      await this.keyRuntime.invoke({ type: "embeddedKeysClear", roleId: this.roleId });
    });
  }

  private async clickAt(
    rawX: number,
    rawY: number,
    viewport: { height: number; width: number },
    options: AutomationInputDispatchOptions
  ): Promise<void> {
    const { postDelayMs = 0, signal, waitForDelay = waitForInputDelay } = options;
    signal?.throwIfAborted();
    const x = Math.max(0, Math.min(viewport.width - 1, Math.round(rawX)));
    const y = Math.max(0, Math.min(viewport.height - 1, Math.round(rawY)));
    const release = {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      x,
      y
    };
    let pressed = false;
    try {
      await this.surface.callDevToolsProtocolMethod("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        x,
        y
      });
      pressed = true;
      signal?.throwIfAborted();
      await this.surface.callDevToolsProtocolMethod("Input.dispatchMouseEvent", release);
      pressed = false;
      options.onClick?.();
    } finally {
      if (pressed) {
        await this.surface.callDevToolsProtocolMethod(
          "Input.dispatchMouseEvent",
          release
        ).catch(() => undefined);
      }
    }
    await waitForDelay(postDelayMs, signal);
  }

  private async executePreparedTransition(
    phase: "hold" | "release" | "tap",
    code: string,
    modifierCodes: string[],
    ownerId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const activeBefore = new Set(this.activeCodes);
    const transition = await this.keyRuntime.invoke({
      type: "embeddedKeyPrepare",
      roleId: this.roleId,
      phase,
      code,
      modifierCodes,
      ownerId
    });
    const executed: EmbeddedKeyEffectRecord[] = [];
    try {
      for (const effect of transition.effects) {
        signal?.throwIfAborted();
        executed.push(effect);
        await this.executeKeyEffect(effect);
      }
      await this.completeTransition(transition, true);
      const finalCodes = transition.effects.at(-1)?.activeCodes;
      this.activeCodes.clear();
      finalCodes?.forEach((activeCode) => this.activeCodes.add(activeCode));
    } catch (error) {
      this.activeCodes.clear();
      activeBefore.forEach((activeCode) => this.activeCodes.add(activeCode));
      for (const effect of executed.reverse()) {
        await this.executeKeyEffect({
          ...effect,
          phase: effect.phase === "rawKeyDown" ? "keyUp" : "rawKeyDown",
          activeCodes: effect.activeCodesBefore,
          activeCodesBefore: effect.activeCodes,
          autoRepeat: false
        }).catch(() => undefined);
      }
      await this.completeTransition(transition, false);
      throw error;
    }
  }

  private executeKeyEffect(effect: EmbeddedKeyEffectRecord): Promise<void> {
    return this.sendKey(
      effect.phase,
      effect.code,
      new Set(effect.activeCodes),
      effect.autoRepeat
    );
  }

  private sendKey(
    type: "keyUp" | "rawKeyDown",
    code: string,
    activeCodes: ReadonlySet<string>,
    autoRepeat = false
  ): Promise<void> {
    const modifiers = getCdpModifierMask(activeCodes);
    return this.surface.callDevToolsProtocolMethod("Input.dispatchKeyEvent", {
      type,
      ...getCdpKeyDescriptor(code, modifiers),
      ...(autoRepeat ? { autoRepeat: true } : {}),
      ...(modifiers > 0 ? { modifiers } : {})
    }).then(() => undefined);
  }

  private async completeTransition(
    transition: EmbeddedKeyTransitionRecord,
    succeeded: boolean
  ): Promise<void> {
    if (!transition.transitionId) return;
    await this.keyRuntime.invoke({
      type: "embeddedKeyComplete",
      transitionId: transition.transitionId,
      succeeded
    });
  }

  private async getViewport(): Promise<{ height: number; width: number }> {
    const metrics = await this.surface
      .callDevToolsProtocolMethod<LayoutMetrics>("Page.getLayoutMetrics")
      .catch((): LayoutMetrics => ({}));
    const viewport = metrics.cssVisualViewport ?? metrics.layoutViewport;
    if (viewport?.clientWidth && viewport.clientHeight) {
      return {
        width: Math.max(1, Math.round(viewport.clientWidth)),
        height: Math.max(1, Math.round(viewport.clientHeight))
      };
    }
    return this.surface.evaluate<{ height: number; width: number }>(
      "({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) })"
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("WebView2 automation target disposed."));
    }
    const result = this.inputLane.catch(() => undefined).then(operation);
    this.inputLane = result.then(() => undefined, () => undefined);
    return result;
  }

  private withLifecycleSignal(
    options: AutomationInputDispatchOptions
  ): AutomationInputDispatchOptions {
    return {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, this.lifecycle.signal])
        : this.lifecycle.signal
    };
  }
}

function toMacroKeyInput(input: MacroKeyInput | string): MacroKeyInput {
  return typeof input === "string" ? { code: input } : input;
}
