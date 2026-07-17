import type { WebContents, WebContentsView, WebFrameMain } from "electron";

import {
  createMacroShortcutSuppressionClearSource,
  createMacroShortcutSuppressionSource
} from "../../shared/macroShortcuts";

export interface BrowserAutomationTarget {
  dispatchClick: (
    xPercent: number,
    yPercent: number,
    options?: BrowserInputDispatchOptions
  ) => Promise<void>;
  dispatchKey: (code: string, options?: BrowserInputDispatchOptions) => Promise<void>;
  holdKey: (
    code: string,
    ownerId: string,
    options?: BrowserInputDispatchOptions
  ) => Promise<void>;
  releaseKey: (code: string, ownerId: string) => Promise<void>;
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
    >
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

  dispatchKey(code: string, options: BrowserInputDispatchOptions = {}): Promise<void> {
    return this.enqueueInput(() => this.dispatchKeyUnlocked(code, options));
  }

  holdKey(
    code: string,
    ownerId: string,
    options: BrowserInputDispatchOptions = {}
  ): Promise<void> {
    return this.enqueueInput(() => this.holdKeyUnlocked(code, ownerId, options));
  }

  releaseKey(code: string, ownerId: string): Promise<void> {
    // Safety releases must not wait behind a stalled click/key operation. The
    // ownership map still makes an overlapping release deterministic.
    return this.releaseKeyUnlocked(code, ownerId);
  }

  private async dispatchKeyUnlocked(code: string, options: BrowserInputDispatchOptions): Promise<void> {
    const { holdMs = 0, postDelayMs = 0, signal } = options;
    signal?.throwIfAborted();
    if (this.webContents.isDestroyed()) {
      return;
    }

    if ((this.heldKeyOwners.get(code)?.size ?? 0) > 0) {
      const suppressionSource = createMacroShortcutSuppressionSource(code);
      await this.evaluateInFrames(suppressionSource);
      try {
        signal?.throwIfAborted();
        this.webContents.sendInputEvent({
          type: "rawKeyDown",
          keyCode: getElectronKeyCode(code),
          isAutoRepeat: true
        } as unknown as Electron.KeyboardInputEvent);
        await waitForInputDelay(holdMs, signal);
      } finally {
        await this.evaluateInFrames(createMacroShortcutSuppressionClearSource(code));
      }
      await waitForInputDelay(postDelayMs, signal);
      return;
    }

    const suppressionSource = createMacroShortcutSuppressionSource(code);
    await this.evaluateInFrames(suppressionSource);

    const keyCode = getElectronKeyCode(code);
    let didSendKeyDown = false;
    let didSendKeyUp = false;
    try {
      signal?.throwIfAborted();
      this.webContents.sendInputEvent({ type: "rawKeyDown", keyCode });
      didSendKeyDown = true;
      await waitForInputDelay(holdMs, signal);
      signal?.throwIfAborted();
      this.webContents.sendInputEvent({ type: "keyUp", keyCode });
      didSendKeyUp = true;
    } finally {
      if (didSendKeyDown && !didSendKeyUp && !this.webContents.isDestroyed()) {
        try {
          this.webContents.sendInputEvent({ type: "keyUp", keyCode });
        } catch {
          // Best-effort recovery for a partially dispatched native key sequence.
        }
      }
      const clearSource = createMacroShortcutSuppressionClearSource(code);
      await this.evaluateInFrames(clearSource);
    }
    await waitForInputDelay(postDelayMs, signal);
  }

  private async holdKeyUnlocked(
    code: string,
    ownerId: string,
    options: BrowserInputDispatchOptions
  ): Promise<void> {
    const { postDelayMs = 0, signal } = options;
    signal?.throwIfAborted();
    if (this.webContents.isDestroyed()) return;

    const existingOwners = this.heldKeyOwners.get(code);
    if (existingOwners?.has(ownerId)) return;
    if (existingOwners && existingOwners.size > 0) {
      existingOwners.add(ownerId);
      return;
    }

    const owners = existingOwners ?? new Set<string>();
    owners.add(ownerId);
    this.heldKeyOwners.set(code, owners);
    let didStartKeyDown = false;
    try {
      await this.evaluateInFrames(createMacroShortcutSuppressionSource(code));
      signal?.throwIfAborted();
      if (this.heldKeyOwners.get(code) !== owners || !owners.has(ownerId)) return;
      didStartKeyDown = true;
      this.webContents.sendInputEvent({ type: "rawKeyDown", keyCode: getElectronKeyCode(code) });
      signal?.throwIfAborted();
    } catch (error) {
      if (owners.has(ownerId)) {
        if (didStartKeyDown) {
          await this.releaseKeyUnlocked(code, ownerId).catch(() => undefined);
        } else {
          owners.delete(ownerId);
          if (owners.size === 0 && this.heldKeyOwners.get(code) === owners) {
            this.heldKeyOwners.delete(code);
          }
        }
      }
      throw error;
    } finally {
      await this.evaluateInFrames(createMacroShortcutSuppressionClearSource(code));
    }
    await waitForInputDelay(postDelayMs, signal);
  }

  private async releaseKeyUnlocked(code: string, ownerId: string): Promise<void> {
    const owners = this.heldKeyOwners.get(code);
    if (!owners?.has(ownerId)) return;
    owners.delete(ownerId);
    if (owners.size > 0) return;
    this.heldKeyOwners.delete(code);
    if (this.webContents.isDestroyed()) return;

    try {
      this.webContents.sendInputEvent({ type: "keyUp", keyCode: getElectronKeyCode(code) });
    } catch (error) {
      try {
        this.webContents.sendInputEvent({ type: "keyUp", keyCode: getElectronKeyCode(code) });
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
    }
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
