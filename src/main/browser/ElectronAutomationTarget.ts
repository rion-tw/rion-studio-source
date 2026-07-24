import type { WebContents, WebContentsView, WebFrameMain } from "electron";

import type {
  EmbeddedKeyEffectRecord,
  EmbeddedKeyTransitionRecord
} from "../../shared/generated";

import {
  createMacroShortcutPhaseSuppressionClearSource,
  createMacroShortcutPhaseSuppressionSource
} from "../../shared/macroShortcuts";
import {
  resolveMacroKeyInput,
  type MacroKeyInput
} from "../../shared/macroKeys";
import { resolveMacroClickOffset } from "../../shared/macroCoordinates";
import type { MacroClickAnchor, MacroClickUnit } from "../../shared/types";
import { getCdpKeyDescriptor, getCdpModifierMask } from "./CdpInput";
import {
  getElectronDebuggerSession,
  type ElectronDebuggerLease,
  type ElectronDebuggerSession
} from "./ElectronDebuggerSession";
import type { EmbeddedKeyRuntimeClient } from "../core/nativeCore";

export interface BrowserAutomationTarget {
  dispose: () => Promise<void>;
  dispatchClick: (
    xPercent: number,
    yPercent: number,
    options?: BrowserInputDispatchOptions
  ) => Promise<void>;
  dispatchClickPixels?: (
    xPx: number,
    yPx: number,
    options?: BrowserInputDispatchOptions
  ) => Promise<void>;
  dispatchClickAnchored?: (
    anchor: MacroClickAnchor | undefined,
    unit: MacroClickUnit,
    x: number,
    y: number,
    options?: BrowserInputDispatchOptions
  ) => Promise<void>;
  dispatchKey: (input: MacroKeyInput | string, options?: BrowserInputDispatchOptions) => Promise<void>;
  holdKey: (
    input: MacroKeyInput | string,
    ownerId: string,
    options?: BrowserInputDispatchOptions
  ) => Promise<void>;
  releaseKey: (input: MacroKeyInput | string, ownerId: string) => Promise<void>;
  ensureInputFocus: () => Promise<boolean>;
  evaluate: <T = unknown>(source: string) => Promise<T>;
  focus: () => Promise<void>;
}

export interface BrowserInputDispatchOptions {
  holdMs?: number;
  onClick?: () => void;
  postDelayMs?: number;
  signal?: AbortSignal;
  waitForDelay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class ElectronAutomationTarget implements BrowserAutomationTarget {
  private readonly debuggerSession: ElectronDebuggerSession;
  private readonly lifecycleAbortController = new AbortController();
  private readonly removeDebuggerDetachListener: () => void;
  private readonly activeCodes = new Set<string>();
  private inputLease?: ElectronDebuggerLease;
  private inputLane: Promise<void> = Promise.resolve();
  private disposePromise?: Promise<void>;
  private disposed = false;
  private reassertInFlight = false;
  private reassertTrailing = false;
  private transientOwnerSequence = 0;
  private readonly handleBlur = (): void => this.scheduleHeldKeyReassertion();
  private readonly handleFocus = (): void => this.scheduleHeldKeyReassertion();

  constructor(
    private readonly view: Pick<WebContentsView, "getBounds">,
    private readonly webContents: Pick<
      WebContents,
      "debugger" | "executeJavaScript" | "focus" | "isDestroyed" | "mainFrame" | "on" | "removeListener"
    >,
    private readonly keyRuntime: EmbeddedKeyRuntimeClient,
    private readonly roleId: string,
    private readonly platform: NodeJS.Platform = "linux"
  ) {
    this.debuggerSession = getElectronDebuggerSession(webContents);
    this.removeDebuggerDetachListener =
      this.debuggerSession.onDetach(() => this.scheduleHeldKeyReassertion());
    this.webContents.on("blur", this.handleBlur);
    this.webContents.on("focus", this.handleFocus);
  }

  async focus(): Promise<void> {
    await this.enqueueInput(async () => {
      this.lifecycleAbortController.signal.throwIfAborted();
      if (this.webContents.isDestroyed()) return;
      this.webContents.focus();
      await this.focusPageTarget(true, this.lifecycleAbortController.signal);
    });
  }

  async ensureInputFocus(): Promise<boolean> {
    return this.enqueueInput(() =>
      this.focusPageTarget(false, this.lifecycleAbortController.signal)
    );
  }

  private async focusPageTarget(allowBodyFallback: boolean, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (this.webContents.isDestroyed()) {
      return false;
    }

    const topLevelResult = await this.webContents
      .executeJavaScript(createFocusSource(false))
      .catch(() => "");
    signal?.throwIfAborted();
    if (topLevelResult === "canvas") {
      return true;
    }

    const frames = [...this.webContents.mainFrame.framesInSubtree].reverse();

    for (const frame of frames) {
      const result = await executeFrameScript(frame, createFocusSource(false)).catch(() => "");
      signal?.throwIfAborted();
      if (result === "canvas") {
        return true;
      }
    }

    const result = await this.webContents
      .executeJavaScript(createFocusSource(true, allowBodyFallback))
      .catch(() => "");
    signal?.throwIfAborted();
    return result === "canvas" || result === "iframe" || result === "body";
  }

  dispatchKey(input: MacroKeyInput | string, options: BrowserInputDispatchOptions = {}): Promise<void> {
    return this.enqueueInput(() =>
      this.dispatchKeyUnlocked(toMacroKeyInput(input), this.withLifecycleSignal(options))
    );
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.reassertTrailing = false;
    this.lifecycleAbortController.abort(new Error("Browser automation target disposed."));
    this.removeDebuggerDetachListener();
    this.webContents.removeListener("blur", this.handleBlur);
    this.webContents.removeListener("focus", this.handleFocus);
    const cleanup = this.inputLane.catch(() => undefined).then(async () => {
      if (!this.webContents.isDestroyed() && this.debuggerSession.isAttached()) {
        const remaining = new Set(this.activeCodes);
        const releaseOrder = [...remaining].sort(
          (left, right) => Number(isModifierCode(left)) - Number(isModifierCode(right))
        );
        for (const code of releaseOrder) {
          remaining.delete(code);
          await this.sendKeyUp(code, remaining).catch(() => undefined);
        }
      }
      this.activeCodes.clear();
      await this.keyRuntime.invoke({ type: "embeddedKeysClear", roleId: this.roleId });
      this.inputLease?.release();
      this.inputLease = undefined;
    });
    this.inputLane = cleanup.catch(() => undefined);
    this.disposePromise = cleanup;
    return cleanup;
  }

  holdKey(
    input: MacroKeyInput | string,
    ownerId: string,
    options: BrowserInputDispatchOptions = {}
  ): Promise<void> {
    return this.enqueueInput(() =>
      this.holdKeyUnlocked(
        toMacroKeyInput(input),
        ownerId,
        this.withLifecycleSignal(options)
      )
    );
  }

  releaseKey(input: MacroKeyInput | string, ownerId: string): Promise<void> {
    return this.enqueueInput(() =>
      this.releaseKeyUnlocked(toMacroKeyInput(input), ownerId)
    );
  }

  private async dispatchKeyUnlocked(input: MacroKeyInput, options: BrowserInputDispatchOptions): Promise<void> {
    const { holdMs = 0, postDelayMs = 0, signal, waitForDelay = waitForInputDelay } = options;
    signal?.throwIfAborted();
    if (this.webContents.isDestroyed()) {
      return;
    }

    const hadInputLease = Boolean(this.inputLease && this.debuggerSession.isAttached());
    await this.ensureInputLease();
    const { code, modifierCodes } = resolveMacroKeyInput(input, this.platform);
    const ownerId = `embedded-tap:${this.roleId}:${++this.transientOwnerSequence}`;
    try {
      if (holdMs <= 0) {
        await this.executePreparedKeyTransition("tap", code, modifierCodes, ownerId, signal);
        await waitForDelay(postDelayMs, signal);
        return;
      }
      await this.executePreparedKeyTransition("hold", code, modifierCodes, ownerId, signal);
      try {
        await waitForDelay(holdMs, signal);
      } finally {
        await this.executePreparedKeyTransition(
          "release",
          code,
          modifierCodes,
          ownerId
        );
      }
      await waitForDelay(postDelayMs, signal);
    } finally {
      if (
        !hadInputLease &&
        !await this.keyRuntime.invoke({ type: "embeddedKeysHeld", roleId: this.roleId })
      ) {
        await this.releaseInputLeaseIfIdle();
      }
    }
  }

  private async holdKeyUnlocked(
    input: MacroKeyInput,
    ownerId: string,
    options: BrowserInputDispatchOptions
  ): Promise<void> {
    const { postDelayMs = 0, signal, waitForDelay = waitForInputDelay } = options;
    signal?.throwIfAborted();
    if (this.webContents.isDestroyed()) return;
    const { code, modifierCodes } = resolveMacroKeyInput(input, this.platform);
    const hadInputLease = Boolean(this.inputLease && this.debuggerSession.isAttached());
    await this.ensureInputLease();
    let held = false;
    try {
      if (
        !hadInputLease &&
        await this.keyRuntime.invoke({ type: "embeddedKeysHeld", roleId: this.roleId })
      ) {
        await this.reassertHeldKeysUnlocked(signal);
      }
      await this.executePreparedKeyTransition("hold", code, modifierCodes, ownerId, signal);
      held = true;
      await waitForDelay(postDelayMs, signal);
    } catch (error) {
      if (held) {
        await this.executePreparedKeyTransition(
          "release",
          code,
          modifierCodes,
          ownerId
        ).catch(() => undefined);
      }
      await this.releaseInputLeaseIfIdle();
      throw error;
    }
  }

  private async releaseKeyUnlocked(input: MacroKeyInput, ownerId: string): Promise<void> {
    if (await this.keyRuntime.invoke({ type: "embeddedKeysHeld", roleId: this.roleId })) {
      await this.ensureInputLease();
    }
    const { code, modifierCodes } = resolveMacroKeyInput(input, this.platform);
    await this.executePreparedKeyTransition("release", code, modifierCodes, ownerId);
    await this.releaseInputLeaseIfIdle();
  }

  private async executePreparedKeyTransition(
    phase: "hold" | "release" | "tap",
    code: string,
    modifierCodes: string[],
    ownerId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const activeCodesBefore = new Set(this.activeCodes);
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
      await this.completeKeyTransition(transition, true);
      const finalCodes = transition.effects.at(-1)?.activeCodes;
      if (finalCodes) {
        this.activeCodes.clear();
        finalCodes.forEach((code) => this.activeCodes.add(code));
      } else if (!transition.hasHeldKeys) {
        this.activeCodes.clear();
      }
    } catch (error) {
      this.activeCodes.clear();
      activeCodesBefore.forEach((code) => this.activeCodes.add(code));
      if (!this.webContents.isDestroyed() && this.debuggerSession.isAttached()) {
        for (const effect of executed.reverse()) {
          await this.executeKeyEffect({
            ...effect,
            phase: effect.phase === "rawKeyDown" ? "keyUp" : "rawKeyDown",
            activeCodes: effect.activeCodesBefore,
            activeCodesBefore: effect.activeCodes,
            autoRepeat: false
          }).catch(() => undefined);
        }
      }
      await this.completeKeyTransition(transition, false);
      throw error;
    }
  }

  private async completeKeyTransition(
    transition: EmbeddedKeyTransitionRecord,
    succeeded: boolean
  ): Promise<void> {
    if (transition.transitionId) {
      await this.keyRuntime.invoke({
        type: "embeddedKeyComplete",
        transitionId: transition.transitionId,
        succeeded
      });
    }
  }

  private async executeKeyEffect(effect: EmbeddedKeyEffectRecord): Promise<void> {
    const shortcutPhase = effect.phase === "rawKeyDown" ? "keydown" : "keyup";
    if (effect.suppressShortcut) {
      await this.suppressShortcutPhase(effect.code, shortcutPhase);
    }
    try {
      if (effect.phase === "rawKeyDown") {
        await this.sendKeyDown(
          effect.code,
          new Set(effect.activeCodes),
          effect.autoRepeat
        );
      } else {
        await this.sendKeyUp(effect.code, new Set(effect.activeCodes));
      }
    } finally {
      if (effect.suppressShortcut) {
        await this.clearShortcutPhase(effect.code, shortcutPhase);
      }
    }
  }

  private sendKeyDown(code: string, activeCodes: ReadonlySet<string>, autoRepeat = false): Promise<void> {
    const modifiers = getCdpModifierMask(activeCodes);
    return this.debuggerSession.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...(autoRepeat ? { autoRepeat: true } : {}),
      ...getCdpKeyDescriptor(code, modifiers),
      ...(modifiers > 0 ? { modifiers } : {})
    }).then(() => undefined);
  }

  private sendKeyUp(code: string, activeCodes: ReadonlySet<string>): Promise<void> {
    const modifiers = getCdpModifierMask(activeCodes);
    return this.debuggerSession.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      ...getCdpKeyDescriptor(code, modifiers),
      ...(modifiers > 0 ? { modifiers } : {})
    }).then(() => undefined);
  }

  private suppressShortcutPhase(code: string, phase: "keydown" | "keyup"): Promise<unknown[]> {
    return this.evaluateInFrames(createMacroShortcutPhaseSuppressionSource(code, phase));
  }

  private clearShortcutPhase(code: string, phase: "keydown" | "keyup"): Promise<unknown[]> {
    return this.evaluateInFrames(createMacroShortcutPhaseSuppressionClearSource(code, phase));
  }

  private evaluateInFrames(source: string): Promise<unknown[]> {
    return Promise.all(
      [...this.webContents.mainFrame.framesInSubtree].map((frame) =>
        executeFrameScript(frame, source).catch(() => undefined)
      )
    );
  }

  dispatchClick(
    xPercent: number,
    yPercent: number,
    options: BrowserInputDispatchOptions = {}
  ): Promise<void> {
    return this.enqueueInput(() =>
      this.dispatchClickUnlocked(xPercent, yPercent, this.withLifecycleSignal(options))
    );
  }

  dispatchClickPixels(xPx: number, yPx: number, options: BrowserInputDispatchOptions = {}): Promise<void> {
    return this.enqueueInput(() =>
      this.dispatchClickPixelsUnlocked(xPx, yPx, this.withLifecycleSignal(options))
    );
  }

  dispatchClickAnchored(
    anchor: MacroClickAnchor | undefined,
    unit: MacroClickUnit,
    x: number,
    y: number,
    options: BrowserInputDispatchOptions = {}
  ): Promise<void> {
    return this.enqueueInput(() =>
      this.dispatchClickAnchoredUnlocked(
        anchor,
        unit,
        x,
        y,
        this.withLifecycleSignal(options)
      )
    );
  }

  private async dispatchClickUnlocked(
    xPercent: number,
    yPercent: number,
    options: BrowserInputDispatchOptions
  ): Promise<void> {
    const { postDelayMs = 0, signal, waitForDelay = waitForInputDelay } = options;
    signal?.throwIfAborted();
    if (this.webContents.isDestroyed()) {
      return;
    }

    await this.ensureInputLease();
    try {
      const viewport = await this.getInputViewport();
      const x = Math.max(0, Math.min(viewport.width - 1, Math.round((viewport.width * xPercent) / 100)));
      const y = Math.max(0, Math.min(viewport.height - 1, Math.round((viewport.height * yPercent) / 100)));
      const release = { type: "mouseReleased", button: "left", clickCount: 1, x, y };
      let didPress = false;
      let didRelease = false;
      try {
        signal?.throwIfAborted();
        await this.debuggerSession.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 1,
          x,
          y
        });
        didPress = true;
        signal?.throwIfAborted();
        await this.debuggerSession.sendCommand("Input.dispatchMouseEvent", release);
        didRelease = true;
      } finally {
        if (didPress && !didRelease && !this.webContents.isDestroyed() && this.debuggerSession.isAttached()) {
          await this.debuggerSession.sendCommand("Input.dispatchMouseEvent", release).catch(() => undefined);
        }
      }
      if (didRelease) options.onClick?.();
      await waitForDelay(postDelayMs, signal);
    } finally {
      await this.releaseInputLeaseIfIdle();
    }
  }

  private async dispatchClickPixelsUnlocked(
    xPx: number,
    yPx: number,
    options: BrowserInputDispatchOptions
  ): Promise<void> {
    const { postDelayMs = 0, signal, waitForDelay = waitForInputDelay } = options;
    signal?.throwIfAborted();
    if (this.webContents.isDestroyed()) return;
    await this.ensureInputLease();
    try {
      const viewport = await this.getInputViewport();
      const x = Math.max(0, Math.min(viewport.width - 1, Math.round(xPx)));
      const y = Math.max(0, Math.min(viewport.height - 1, Math.round(yPx)));
      const release = { type: "mouseReleased", button: "left", clickCount: 1, x, y };
      let didPress = false;
      let didRelease = false;
      try {
        await this.debuggerSession.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed", button: "left", clickCount: 1, x, y
        });
        didPress = true;
        signal?.throwIfAborted();
        await this.debuggerSession.sendCommand("Input.dispatchMouseEvent", release);
        didRelease = true;
      } finally {
        if (didPress && !didRelease && !this.webContents.isDestroyed() && this.debuggerSession.isAttached()) {
          await this.debuggerSession.sendCommand("Input.dispatchMouseEvent", release).catch(() => undefined);
        }
      }
      if (didRelease) options.onClick?.();
      await waitForDelay(postDelayMs, signal);
    } finally {
      await this.releaseInputLeaseIfIdle();
    }
  }

  private async dispatchClickAnchoredUnlocked(
    anchor: MacroClickAnchor | undefined,
    unit: MacroClickUnit,
    xOffset: number,
    yOffset: number,
    options: BrowserInputDispatchOptions
  ): Promise<void> {
    const { postDelayMs = 0, signal, waitForDelay = waitForInputDelay } = options;
    signal?.throwIfAborted();
    if (this.webContents.isDestroyed()) return;
    await this.ensureInputLease();
    try {
      const viewport = await this.getInputViewport();
      const resolved = resolveMacroClickOffset({ anchor, unit, x: xOffset, y: yOffset }, viewport);
      const x = Math.max(0, Math.min(viewport.width - 1, Math.round(
        unit === "percent" ? (viewport.width * resolved.x) / 100 : resolved.x
      )));
      const y = Math.max(0, Math.min(viewport.height - 1, Math.round(
        unit === "percent" ? (viewport.height * resolved.y) / 100 : resolved.y
      )));
      const release = { type: "mouseReleased", button: "left", clickCount: 1, x, y };
      let didPress = false;
      let didRelease = false;
      try {
        signal?.throwIfAborted();
        await this.debuggerSession.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 1,
          x,
          y
        });
        didPress = true;
        signal?.throwIfAborted();
        await this.debuggerSession.sendCommand("Input.dispatchMouseEvent", release);
        didRelease = true;
      } finally {
        if (didPress && !didRelease && !this.webContents.isDestroyed() && this.debuggerSession.isAttached()) {
          await this.debuggerSession.sendCommand("Input.dispatchMouseEvent", release).catch(() => undefined);
        }
      }
      if (didRelease) options.onClick?.();
      await waitForDelay(postDelayMs, signal);
    } finally {
      await this.releaseInputLeaseIfIdle();
    }
  }

  private async ensureInputLease(): Promise<void> {
    if (this.inputLease && this.debuggerSession.isAttached()) {
      return;
    }

    this.inputLease?.release();
    this.inputLease = await this.debuggerSession.acquire();
  }

  private async releaseInputLeaseIfIdle(): Promise<void> {
    if (await this.keyRuntime.invoke({ type: "embeddedKeysHeld", roleId: this.roleId })) return;
    this.inputLease?.release();
    this.inputLease = undefined;
  }

  private scheduleHeldKeyReassertion(): void {
    if (this.disposed || this.webContents.isDestroyed()) return;
    if (this.reassertInFlight) {
      this.reassertTrailing = true;
      return;
    }
    this.reassertInFlight = true;
    void this.enqueueInput(async () => {
      if (
        !this.disposed &&
        await this.keyRuntime.invoke({ type: "embeddedKeysHeld", roleId: this.roleId })
      ) {
        await this.reassertHeldKeysUnlocked(this.lifecycleAbortController.signal);
      }
    }).catch(() => undefined).finally(() => {
      this.reassertInFlight = false;
      if (this.reassertTrailing && !this.disposed) {
        this.reassertTrailing = false;
        this.scheduleHeldKeyReassertion();
      }
    });
  }

  private async reassertHeldKeysUnlocked(signal?: AbortSignal): Promise<void> {
    if (
      this.webContents.isDestroyed() ||
      !await this.keyRuntime.invoke({ type: "embeddedKeysHeld", roleId: this.roleId })
    ) return;
    await this.ensureInputLease();
    const transition = await this.keyRuntime.invoke({
      type: "embeddedKeysReassert",
      roleId: this.roleId
    });
    for (const effect of transition.effects) {
      signal?.throwIfAborted();
      await this.executeKeyEffect(effect);
    }
  }

  private async getInputViewport(): Promise<{ height: number; width: number }> {
    type LayoutMetrics = {
      cssVisualViewport?: { clientHeight?: number; clientWidth?: number };
      layoutViewport?: { clientHeight?: number; clientWidth?: number };
    };
    const metrics = await this.debuggerSession.sendCommand<LayoutMetrics>("Page.getLayoutMetrics")
      .catch((): LayoutMetrics => ({}));
    const viewport = metrics.cssVisualViewport ?? metrics.layoutViewport;
    const bounds = this.view.getBounds();
    const width = viewport?.clientWidth ?? bounds.width;
    const height = viewport?.clientHeight ?? bounds.height;
    return {
      height: Math.max(1, Math.round(height)),
      width: Math.max(1, Math.round(width))
    };
  }

  async evaluate<T = unknown>(source: string): Promise<T> {
    return this.enqueueInput(async () => {
      this.lifecycleAbortController.signal.throwIfAborted();
      return (await this.webContents.executeJavaScript(source)) as T;
    });
  }

  private enqueueInput<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("Browser automation target disposed."));
    }
    const result = this.inputLane.catch(() => undefined).then(operation);
    this.inputLane = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private withLifecycleSignal(
    options: BrowserInputDispatchOptions
  ): BrowserInputDispatchOptions {
    return {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, this.lifecycleAbortController.signal])
        : this.lifecycleAbortController.signal
    };
  }
}

function isModifierCode(code: string): boolean {
  return /^(Alt|Control|Meta|Shift)(Left|Right)$/.test(code);
}

export function waitForInputDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    const handleAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Macro input cancelled."));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
    }
  });
}

function executeFrameScript(frame: WebFrameMain, source: string): Promise<unknown> {
  return frame.executeJavaScript(source);
}

export function createFocusSource(allowFallback: boolean, allowBodyFallback = allowFallback): string {
  return `(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const focusElement = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (document.activeElement === element) return true;
      const hadTabIndex = element.hasAttribute("tabindex");
      if (!hadTabIndex) element.setAttribute("tabindex", "-1");
      try { element.focus({ preventScroll: true }); } catch { element.focus(); }
      if (!hadTabIndex && element !== document.body) {
        setTimeout(() => element.removeAttribute("tabindex"), 0);
      }
      return document.activeElement === element;
    };
    const largest = (selector) => Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return b.width * b.height - a.width * a.height;
      })[0];
    if (focusElement(largest("canvas"))) return "canvas";
    if (!${JSON.stringify(allowFallback)}) return "";
    if (focusElement(largest("iframe"))) return "iframe";
    if (!${JSON.stringify(allowBodyFallback)}) return "";
    return focusElement(document.body) ? "body" : "";
  })()`;
}

function toMacroKeyInput(input: MacroKeyInput | string): MacroKeyInput {
  return typeof input === "string" ? { code: input } : input;
}
