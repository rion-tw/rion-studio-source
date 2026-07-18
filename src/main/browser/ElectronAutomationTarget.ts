import type { WebContents, WebContentsView, WebFrameMain } from "electron";

import {
  createMacroShortcutPhaseSuppressionClearSource,
  createMacroShortcutPhaseSuppressionSource
} from "../../shared/macroShortcuts";
import {
  getMacroModifierForCode,
  resolveMacroKeyInput,
  type MacroKeyInput
} from "../../shared/macroKeys";

export interface BrowserAutomationTarget {
  dispatchClick: (
    xPercent: number,
    yPercent: number,
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
  postDelayMs?: number;
  signal?: AbortSignal;
}

export class ElectronAutomationTarget implements BrowserAutomationTarget {
  private readonly heldKeyOwners = new Map<string, Set<string>>();
  private inputDispatchTail: Promise<void> = Promise.resolve();
  private syntheticClickDispatchDepth = 0;

  constructor(
    private readonly view: Pick<WebContentsView, "getBounds">,
    private readonly webContents: Pick<
      WebContents,
      "executeJavaScript" | "focus" | "isDestroyed" | "mainFrame" | "on" | "sendInputEvent"
    >,
    private readonly platform: NodeJS.Platform = "linux"
  ) {
    this.webContents.on("before-mouse-event", (_event, mouse) => {
      if (
        this.syntheticClickDispatchDepth > 0 ||
        mouse.type !== "mouseDown" ||
        mouse.button !== "left"
      ) {
        return;
      }

      void this.focusCanvasAtPoint(mouse.x, mouse.y);
    });
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

  private async focusCanvasAtPoint(x: number, y: number): Promise<boolean> {
    if (this.webContents.isDestroyed()) {
      return false;
    }

    return Boolean(
      await this.webContents
        .executeJavaScript(createCanvasFocusAtPointSource(x, y))
        .catch(() => false)
    );
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

    const { code, modifierCodes } = resolveMacroKeyInput(input, this.platform);
    const activeCodes = new Set(this.heldKeyOwners.keys());
    const pressedCodes: string[] = [];
    try {
      for (const modifierCode of modifierCodes) {
        signal?.throwIfAborted();
        if (activeCodes.has(modifierCode)) continue;
        activeCodes.add(modifierCode);
        this.sendKeyDown(modifierCode, activeCodes);
        pressedCodes.push(modifierCode);
      }

      await this.suppressShortcutPhase(code, "keydown");
      signal?.throwIfAborted();
      if (activeCodes.has(code)) {
        this.sendKeyDown(code, activeCodes, true);
      } else {
        activeCodes.add(code);
        this.sendKeyDown(code, activeCodes);
        pressedCodes.push(code);
      }
      await this.clearShortcutPhase(code, "keydown");
      await waitForInputDelay(holdMs, signal);

      if (pressedCodes.at(-1) === code) {
        signal?.throwIfAborted();
        await this.suppressShortcutPhase(code, "keyup");
        activeCodes.delete(code);
        this.sendKeyUp(code, activeCodes);
        pressedCodes.pop();
        await this.clearShortcutPhase(code, "keyup");
      }

      for (const modifierCode of [...modifierCodes].reverse()) {
        const index = pressedCodes.lastIndexOf(modifierCode);
        if (index === -1) continue;
        activeCodes.delete(modifierCode);
        this.sendKeyUp(modifierCode, activeCodes);
        pressedCodes.splice(index, 1);
      }
    } finally {
      if (!this.webContents.isDestroyed()) {
        for (const pressedCode of [...pressedCodes].reverse()) {
          if (pressedCode === code) {
            await this.suppressShortcutPhase(code, "keyup").catch(() => undefined);
          }
          activeCodes.delete(pressedCode);
          try {
            this.sendKeyUp(pressedCode, activeCodes);
          } catch {
            // Best-effort recovery for a partially dispatched native key sequence.
          }
        }
      }
      await Promise.all([
        this.clearShortcutPhase(code, "keydown"),
        this.clearShortcutPhase(code, "keyup")
      ]);
    }
    await waitForInputDelay(postDelayMs, signal);
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
    const acquiredCodes: string[] = [];
    try {
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
        this.sendKeyDown(currentCode, new Set(this.heldKeyOwners.keys()));
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
      throw error;
    } finally {
      await this.clearShortcutPhase(code, "keydown");
    }
  }

  private async releaseKeyUnlocked(input: MacroKeyInput, ownerId: string): Promise<void> {
    const { code, modifierCodes } = resolveMacroKeyInput(input, this.platform);
    for (const currentCode of [code, ...modifierCodes.slice().reverse()]) {
      await this.releaseOwnedKey(currentCode, ownerId, currentCode === code);
    }
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
      this.sendKeyUp(code, new Set(this.heldKeyOwners.keys()));
    } catch (error) {
      try {
        this.sendKeyUp(code, new Set(this.heldKeyOwners.keys()));
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

  private sendKeyDown(code: string, activeCodes: ReadonlySet<string>, autoRepeat = false): void {
    const modifiers = getElectronModifiers(activeCodes);
    this.webContents.sendInputEvent({
      type: "rawKeyDown",
      keyCode: getElectronKeyCode(code),
      ...(modifiers.length > 0 ? { modifiers } : {}),
      ...(autoRepeat ? { isAutoRepeat: true } : {})
    } as unknown as Electron.KeyboardInputEvent);
  }

  private sendKeyUp(code: string, activeCodes: ReadonlySet<string>): void {
    const modifiers = getElectronModifiers(activeCodes);
    this.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: getElectronKeyCode(code),
      ...(modifiers.length > 0 ? { modifiers } : {})
    });
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

    const bounds = this.view.getBounds();
    const x = Math.max(0, Math.min(bounds.width - 1, Math.round((bounds.width * xPercent) / 100)));
    const y = Math.max(0, Math.min(bounds.height - 1, Math.round((bounds.height * yPercent) / 100)));
    const release = { type: "mouseUp" as const, button: "left" as const, clickCount: 1, x, y };
    let didPress = false;
    let didRelease = false;
    this.syntheticClickDispatchDepth += 1;
    try {
      this.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x, y });
      didPress = true;
      this.webContents.sendInputEvent(release);
      didRelease = true;
    } finally {
      if (didPress && !didRelease && !this.webContents.isDestroyed()) {
        try {
          this.webContents.sendInputEvent(release);
        } catch {
          // Best-effort recovery for a partially dispatched native click sequence.
        }
      }
      this.syntheticClickDispatchDepth -= 1;
    }
    await waitForInputDelay(postDelayMs, signal);
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

export function createCanvasFocusAtPointSource(x: number, y: number): string {
  return `(() => {
    const x = ${JSON.stringify(x)};
    const y = ${JSON.stringify(y)};
    let element = document.elementFromPoint(x, y);
    while (element?.shadowRoot) {
      const nested = element.shadowRoot.elementFromPoint(x, y);
      if (!nested || nested === element) break;
      element = nested;
    }
    if (!(element instanceof HTMLCanvasElement)) return false;
    if (document.activeElement === element) return true;
    const hadTabIndex = element.hasAttribute("tabindex");
    if (!hadTabIndex) element.setAttribute("tabindex", "-1");
    try { element.focus({ preventScroll: true }); } catch { element.focus(); }
    if (!hadTabIndex) setTimeout(() => element.removeAttribute("tabindex"), 0);
    return document.activeElement === element;
  })()`;
}

function getElectronKeyCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }

  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }

  if (/^Numpad[0-9]$/.test(code)) {
    return `num${code.slice(6)}`;
  }

  return electronKeyCodes[code] ?? code;
}

function toMacroKeyInput(input: MacroKeyInput | string): MacroKeyInput {
  return typeof input === "string" ? { code: input } : input;
}

function getElectronModifiers(
  activeCodes: ReadonlySet<string>
): Array<"control" | "alt" | "shift" | "meta"> {
  const activeModifiers = new Set(
    [...activeCodes].map(getMacroModifierForCode).filter(Boolean)
  );
  return [
    activeModifiers.has("ctrl") ? "control" : undefined,
    activeModifiers.has("alt") ? "alt" : undefined,
    activeModifiers.has("shift") ? "shift" : undefined,
    activeModifiers.has("meta") ? "meta" : undefined
  ].filter(
    (modifier): modifier is "control" | "alt" | "shift" | "meta" => Boolean(modifier)
  );
}

const electronKeyCodes: Record<string, string> = {
  AltLeft: "Alt",
  AltRight: "Alt",
  ControlLeft: "Control",
  ControlRight: "Control",
  MetaLeft: "Meta",
  MetaRight: "Meta",
  NumpadAdd: "numadd",
  NumpadDecimal: "numdec",
  NumpadDivide: "numdiv",
  NumpadMultiply: "nummult",
  NumpadSubtract: "numsub",
  ShiftLeft: "Shift",
  ShiftRight: "Shift"
};
