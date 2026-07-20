import type { WebContents, WebContentsView, WebFrameMain } from "electron";

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

export interface BrowserAutomationTarget {
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
}

export class ElectronAutomationTarget implements BrowserAutomationTarget {
  private readonly heldKeyOwners = new Map<string, Set<string>>();
  private readonly debuggerSession: ElectronDebuggerSession;
  private inputLease?: ElectronDebuggerLease;
  private inputDispatchTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly view: Pick<WebContentsView, "getBounds">,
    private readonly webContents: Pick<
      WebContents,
      "debugger" | "executeJavaScript" | "focus" | "isDestroyed" | "mainFrame" | "on"
    >,
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
    return this.enqueueInput(() => this.dispatchKeyUnlocked(toMacroKeyInput(input), options));
  }

  holdKey(
    input: MacroKeyInput | string,
    ownerId: string,
    options: BrowserInputDispatchOptions = {}
  ): Promise<void> {
    return this.enqueueInput(() => this.holdKeyUnlocked(toMacroKeyInput(input), ownerId, options));
  }

  releaseKey(input: MacroKeyInput | string, ownerId: string): Promise<void> {
    return this.enqueueInput(() => this.releaseKeyUnlocked(toMacroKeyInput(input), ownerId));
  }

  private async dispatchKeyUnlocked(input: MacroKeyInput, options: BrowserInputDispatchOptions): Promise<void> {
    const { holdMs = 0, postDelayMs = 0, signal } = options;
    signal?.throwIfAborted();
    if (this.webContents.isDestroyed()) {
      return;
    }

    const hadInputLease = Boolean(this.inputLease && this.debuggerSession.isAttached());
    await this.ensureInputLease();
    try {
      const { code, modifierCodes } = resolveMacroKeyInput(input, this.platform);
      const activeCodes = new Set(this.heldKeyOwners.keys());
      const pressedCodes: string[] = [];
      try {
        for (const modifierCode of modifierCodes) {
          signal?.throwIfAborted();
          if (activeCodes.has(modifierCode)) continue;
          activeCodes.add(modifierCode);
          await this.sendKeyDown(modifierCode, activeCodes);
          pressedCodes.push(modifierCode);
        }

        await this.suppressShortcutPhase(code, "keydown");
        signal?.throwIfAborted();
        if (activeCodes.has(code)) {
          await this.sendKeyDown(code, activeCodes, true);
        } else {
          activeCodes.add(code);
          await this.sendKeyDown(code, activeCodes);
          pressedCodes.push(code);
        }
        await this.clearShortcutPhase(code, "keydown");
        await waitForInputDelay(holdMs, signal);

        if (pressedCodes.at(-1) === code) {
          signal?.throwIfAborted();
          await this.suppressShortcutPhase(code, "keyup");
          activeCodes.delete(code);
          await this.sendKeyUp(code, activeCodes);
          pressedCodes.pop();
          await this.clearShortcutPhase(code, "keyup");
        }

        for (const modifierCode of [...modifierCodes].reverse()) {
          const index = pressedCodes.lastIndexOf(modifierCode);
          if (index === -1) continue;
          activeCodes.delete(modifierCode);
          await this.sendKeyUp(modifierCode, activeCodes);
          pressedCodes.splice(index, 1);
        }
      } finally {
        if (!this.webContents.isDestroyed() && this.debuggerSession.isAttached()) {
          for (const pressedCode of [...pressedCodes].reverse()) {
            if (pressedCode === code) {
              await this.suppressShortcutPhase(code, "keyup").catch(() => undefined);
            }
            activeCodes.delete(pressedCode);
            await this.sendKeyUp(pressedCode, activeCodes).catch(() => undefined);
          }
        }
        await Promise.all([
          this.clearShortcutPhase(code, "keydown"),
          this.clearShortcutPhase(code, "keyup")
        ]);
      }
      await waitForInputDelay(postDelayMs, signal);
    } finally {
      if (!hadInputLease && this.heldKeyOwners.size === 0) {
        this.releaseInputLeaseIfIdle();
      }
    }
  }

  private async holdKeyUnlocked(
    input: MacroKeyInput,
    ownerId: string,
    options: BrowserInputDispatchOptions
  ): Promise<void> {
    const { postDelayMs = 0, signal } = options;
    signal?.throwIfAborted();
    if (this.webContents.isDestroyed()) return;
    const { code, modifierCodes } = resolveMacroKeyInput(input, this.platform);
    const codes = [...modifierCodes, code];
    const hadInputLease = Boolean(this.inputLease && this.debuggerSession.isAttached());
    await this.ensureInputLease();
    const acquiredCodes: string[] = [];
    try {
      if (!hadInputLease && this.heldKeyOwners.size > 0) {
        await this.reassertHeldKeysUnlocked(signal);
      }
      for (const currentCode of codes) {
        signal?.throwIfAborted();
        const existingOwners = this.heldKeyOwners.get(currentCode);
        if (existingOwners?.has(ownerId)) continue;
        const owners = existingOwners ?? new Set<string>();
        owners.add(ownerId);
        this.heldKeyOwners.set(currentCode, owners);
        acquiredCodes.push(currentCode);
        if (existingOwners && existingOwners.size > 0) continue;

        if (currentCode === code) {
          await this.suppressShortcutPhase(code, "keydown");
        }
        await this.sendKeyDown(currentCode, new Set(this.heldKeyOwners.keys()));
        signal?.throwIfAborted();
        if (currentCode === code) {
          await this.clearShortcutPhase(code, "keydown");
        }
      }
      await waitForInputDelay(postDelayMs, signal);
    } catch (error) {
      for (const acquiredCode of [...acquiredCodes].reverse()) {
        await this.releaseOwnedKey(
          acquiredCode,
          ownerId,
          acquiredCode === code
        ).catch(() => undefined);
      }
      this.releaseInputLeaseIfIdle();
      throw error;
    } finally {
      await this.clearShortcutPhase(code, "keydown");
    }
  }

  private async releaseKeyUnlocked(input: MacroKeyInput, ownerId: string): Promise<void> {
    if (this.heldKeyOwners.size > 0) {
      await this.ensureInputLease();
    }
    const { code, modifierCodes } = resolveMacroKeyInput(input, this.platform);
    for (const currentCode of [code, ...modifierCodes.slice().reverse()]) {
      await this.releaseOwnedKey(currentCode, ownerId, currentCode === code);
    }
    this.releaseInputLeaseIfIdle();
  }

  private async releaseOwnedKey(code: string, ownerId: string, suppressShortcut: boolean): Promise<void> {
    const owners = this.heldKeyOwners.get(code);
    if (!owners?.has(ownerId)) return;
    owners.delete(ownerId);
    if (owners.size > 0) return;
    this.heldKeyOwners.delete(code);
    if (this.webContents.isDestroyed()) return;

    if (suppressShortcut) {
      await this.suppressShortcutPhase(code, "keyup").catch(() => undefined);
    }
    try {
      await this.sendKeyUp(code, new Set(this.heldKeyOwners.keys()));
    } catch (error) {
      try {
        await this.sendKeyUp(code, new Set(this.heldKeyOwners.keys()));
        return;
      } catch {
        const currentOwners = this.heldKeyOwners.get(code);
        if (currentOwners) {
          currentOwners.add(ownerId);
        } else {
          owners.add(ownerId);
          this.heldKeyOwners.set(code, owners);
        }
      }
      throw error;
    } finally {
      if (suppressShortcut) {
        await this.clearShortcutPhase(code, "keyup");
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
    return this.enqueueInput(() => this.dispatchClickUnlocked(xPercent, yPercent, options));
  }

  dispatchClickPixels(xPx: number, yPx: number, options: BrowserInputDispatchOptions = {}): Promise<void> {
    return this.enqueueInput(() => this.dispatchClickPixelsUnlocked(xPx, yPx, options));
  }

  dispatchClickAnchored(
    anchor: MacroClickAnchor | undefined,
    unit: MacroClickUnit,
    x: number,
    y: number,
    options: BrowserInputDispatchOptions = {}
  ): Promise<void> {
    return this.enqueueInput(() => this.dispatchClickAnchoredUnlocked(anchor, unit, x, y, options));
  }

  private async dispatchClickUnlocked(
    xPercent: number,
    yPercent: number,
    options: BrowserInputDispatchOptions
  ): Promise<void> {
    const { postDelayMs = 0, signal } = options;
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
      await waitForInputDelay(postDelayMs, signal);
    } finally {
      this.releaseInputLeaseIfIdle();
    }
  }

  private async dispatchClickPixelsUnlocked(
    xPx: number,
    yPx: number,
    options: BrowserInputDispatchOptions
  ): Promise<void> {
    const { postDelayMs = 0, signal } = options;
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
      await waitForInputDelay(postDelayMs, signal);
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
    const { postDelayMs = 0, signal } = options;
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
      await waitForInputDelay(postDelayMs, signal);
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
    if (this.heldKeyOwners.size > 0) return;
    this.inputLease?.release();
    this.inputLease = undefined;
  }

  private scheduleHeldKeyReassertion(): void {
    if (this.heldKeyOwners.size === 0 || this.webContents.isDestroyed()) return;
    void this.enqueueInput(() => this.reassertHeldKeysUnlocked()).catch(() => undefined);
  }

  private async reassertHeldKeysUnlocked(signal?: AbortSignal): Promise<void> {
    if (this.heldKeyOwners.size === 0 || this.webContents.isDestroyed()) return;
    await this.ensureInputLease();
    const activeCodes = new Set(this.heldKeyOwners.keys());
    for (const code of activeCodes) {
      signal?.throwIfAborted();
      if (!this.isModifierCode(code)) {
        await this.suppressShortcutPhase(code, "keydown");
      }
      await this.sendKeyDown(code, activeCodes);
      if (!this.isModifierCode(code)) {
        await this.clearShortcutPhase(code, "keydown");
      }
    }
  }

  private isModifierCode(code: string): boolean {
    return code === "AltLeft" || code === "AltRight" ||
      code === "ControlLeft" || code === "ControlRight" ||
      code === "MetaLeft" || code === "MetaRight" ||
      code === "ShiftLeft" || code === "ShiftRight";
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

  private enqueueInput(operation: () => Promise<void>): Promise<void> {
    const result = this.inputDispatchTail.then(operation);
    this.inputDispatchTail = result.catch(() => undefined);
    return result;
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
