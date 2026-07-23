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
  dispose: () => void;
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
  private inputLease?: ElectronDebuggerLease;
  private transientOwnerSequence = 0;

  constructor(
    private readonly view: Pick<WebContentsView, "getBounds">,
    private readonly webContents: Pick<
      WebContents,
      "debugger" | "executeJavaScript" | "focus" | "isDestroyed" | "mainFrame" | "on"
    >,
    private readonly keyRuntime: EmbeddedKeyRuntimeClient,
    private readonly roleId: string,
    private readonly platform: NodeJS.Platform = "linux"
  ) {
    this.debuggerSession = getElectronDebuggerSession(webContents);
    this.debuggerSession.onDetach(() => this.scheduleHeldKeyReassertion());
    this.webContents.on("blur", () => this.scheduleHeldKeyReassertion());
    this.webContents.on("focus", () => this.scheduleHeldKeyReassertion());
  }

  async focus(): Promise<void> {
    if (this.webContents.isDestroyed()) {
      return;
    }

    this.webContents.focus();
    await this.focusPageTarget(true);
  }

  async ensureInputFocus(): Promise<boolean> {
    return this.focusPageTarget(false);
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
    return this.dispatchKeyUnlocked(toMacroKeyInput(input), options);
  }

  dispose(): void {
    this.keyRuntime.clearEmbeddedKeys(this.roleId);
    this.inputLease?.release();
    this.inputLease = undefined;
  }

  holdKey(
    input: MacroKeyInput | string,
    ownerId: string,
    options: BrowserInputDispatchOptions = {}
  ): Promise<void> {
    return this.holdKeyUnlocked(toMacroKeyInput(input), ownerId, options);
  }

  releaseKey(input: MacroKeyInput | string, ownerId: string): Promise<void> {
    return this.releaseKeyUnlocked(toMacroKeyInput(input), ownerId);
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
      if (!hadInputLease && !this.keyRuntime.hasEmbeddedHeldKeys(this.roleId)) {
        this.releaseInputLeaseIfIdle();
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
      if (!hadInputLease && this.keyRuntime.hasEmbeddedHeldKeys(this.roleId)) {
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
      this.releaseInputLeaseIfIdle();
      throw error;
    }
  }

  private async releaseKeyUnlocked(input: MacroKeyInput, ownerId: string): Promise<void> {
    if (this.keyRuntime.hasEmbeddedHeldKeys(this.roleId)) {
      await this.ensureInputLease();
    }
    const { code, modifierCodes } = resolveMacroKeyInput(input, this.platform);
    await this.executePreparedKeyTransition("release", code, modifierCodes, ownerId);
    this.releaseInputLeaseIfIdle();
  }

  private async executePreparedKeyTransition(
    phase: "hold" | "release" | "tap",
    code: string,
    modifierCodes: string[],
    ownerId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const transition = this.keyRuntime.prepareEmbeddedKeyTransition(
      this.roleId,
      phase,
      code,
      modifierCodes,
      ownerId
    );
    const executed: EmbeddedKeyEffectRecord[] = [];
    try {
      for (const effect of transition.effects) {
        signal?.throwIfAborted();
        executed.push(effect);
        await this.executeKeyEffect(effect);
      }
      this.completeKeyTransition(transition, true);
    } catch (error) {
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
      this.completeKeyTransition(transition, false);
      throw error;
    }
  }

  private completeKeyTransition(
    transition: EmbeddedKeyTransitionRecord,
    succeeded: boolean
  ): void {
    if (transition.transitionId) {
      this.keyRuntime.completeEmbeddedKeyTransition(transition.transitionId, succeeded);
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
    return this.dispatchClickUnlocked(xPercent, yPercent, options);
  }

  dispatchClickPixels(xPx: number, yPx: number, options: BrowserInputDispatchOptions = {}): Promise<void> {
    return this.dispatchClickPixelsUnlocked(xPx, yPx, options);
  }

  dispatchClickAnchored(
    anchor: MacroClickAnchor | undefined,
    unit: MacroClickUnit,
    x: number,
    y: number,
    options: BrowserInputDispatchOptions = {}
  ): Promise<void> {
    return this.dispatchClickAnchoredUnlocked(anchor, unit, x, y, options);
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
      this.releaseInputLeaseIfIdle();
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
      this.releaseInputLeaseIfIdle();
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
      this.releaseInputLeaseIfIdle();
    }
  }

  private async ensureInputLease(): Promise<void> {
    if (this.inputLease && this.debuggerSession.isAttached()) {
      return;
    }

    this.inputLease?.release();
    this.inputLease = await this.debuggerSession.acquire();
  }

  private releaseInputLeaseIfIdle(): void {
    if (this.keyRuntime.hasEmbeddedHeldKeys(this.roleId)) return;
    this.inputLease?.release();
    this.inputLease = undefined;
  }

  private scheduleHeldKeyReassertion(): void {
    if (!this.keyRuntime.hasEmbeddedHeldKeys(this.roleId) || this.webContents.isDestroyed()) return;
    void this.reassertHeldKeysUnlocked().catch(() => undefined);
  }

  private async reassertHeldKeysUnlocked(signal?: AbortSignal): Promise<void> {
    if (!this.keyRuntime.hasEmbeddedHeldKeys(this.roleId) || this.webContents.isDestroyed()) return;
    await this.ensureInputLease();
    const transition = this.keyRuntime.reassertEmbeddedKeys(this.roleId);
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
    return (await this.webContents.executeJavaScript(source)) as T;
  }
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
