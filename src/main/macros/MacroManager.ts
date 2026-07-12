import { EventEmitter } from "node:events";

import type { CDPSession, Page } from "playwright-core";

import type { Macro, MacroRunStatus, MacroStep } from "../../shared/types";
import type { BrowserManager } from "../browser/BrowserManager";
import type { MacroStore } from "./MacroStore";

export interface MacroManagerEvents {
  change: [MacroRunStatus[]];
}

interface MacroRun {
  cancelDelay?: () => void;
  isCancelled: boolean;
  status: MacroRunStatus;
}

interface KeyDefinition {
  key: string;
  windowsVirtualKeyCode: number;
}

class MacroRunCancelledError extends Error {
  constructor() {
    super("Macro run cancelled.");
    this.name = "MacroRunCancelledError";
  }
}

export class MacroManager extends EventEmitter<MacroManagerEvents> {
  private readonly runs = new Map<string, MacroRun>();

  constructor(
    private readonly browserManager: Pick<BrowserManager, "getAutomationSession">,
    private readonly macroStore: Pick<MacroStore, "getMacro">
  ) {
    super();
  }

  listStatuses(): MacroRunStatus[] {
    return [...this.runs.values()].map((run) => run.status);
  }

  async start(roleId: string, macroId: string): Promise<MacroRunStatus> {
    const key = createRunKey(roleId, macroId);

    if (this.runs.has(key)) {
      throw new Error("Macro is already running for this role.");
    }

    const macro = await this.macroStore.getMacro(macroId);

    if (macro.roleId !== roleId) {
      throw new Error("Macro is not assigned to this role.");
    }

    const session = this.browserManager.getAutomationSession(roleId);

    if (!session) {
      throw new Error("Launch this role before running a macro.");
    }

    const now = new Date().toISOString();
    const run: MacroRun = {
      isCancelled: false,
      status: {
        roleId,
        macroId,
        state: "running",
        startedAt: now,
        updatedAt: now
      }
    };

    this.runs.set(key, run);
    this.emitChange();

    void this.runMacro(key, run, macro, session.page)
      .catch((error) => {
        if (!(error instanceof MacroRunCancelledError)) {
          console.warn("Macro execution failed.", error);
        }
      })
      .finally(() => {
        if (this.runs.get(key) === run) {
          this.runs.delete(key);
          this.emitChange();
        }
      });

    return run.status;
  }

  async stop(roleId: string, macroId: string): Promise<void> {
    const run = this.runs.get(createRunKey(roleId, macroId));

    if (!run) {
      return;
    }

    run.isCancelled = true;
    run.status = {
      ...run.status,
      state: "stopping",
      updatedAt: new Date().toISOString()
    };
    run.cancelDelay?.();
    this.emitChange();
  }

  async stopRole(roleId: string): Promise<void> {
    await Promise.all(
      this.listStatuses()
        .filter((status) => status.roleId === roleId)
        .map((status) => this.stop(status.roleId, status.macroId))
    );
  }

  private async runMacro(runKey: string, run: MacroRun, macro: Macro, page: Page): Promise<void> {
    do {
      for (const step of macro.steps) {
        this.throwIfCancelled(run);
        await executeMacroStep(page, step);
      }

      if (macro.repeat.type !== "loop") {
        break;
      }

      await this.delay(run, macro.repeat.intervalMs);
    } while (!run.isCancelled && this.runs.get(runKey) === run);
  }

  private async delay(run: MacroRun, ms: number): Promise<void> {
    this.throwIfCancelled(run);

    if (ms === 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        run.cancelDelay = undefined;
        resolve();
      }, ms);

      run.cancelDelay = () => {
        clearTimeout(timer);
        run.cancelDelay = undefined;
        reject(new MacroRunCancelledError());
      };
    });

    this.throwIfCancelled(run);
  }

  private throwIfCancelled(run: MacroRun): void {
    if (run.isCancelled) {
      throw new MacroRunCancelledError();
    }
  }

  private emitChange(): void {
    this.emit("change", this.listStatuses());
  }
}

async function executeMacroStep(page: Page, step: MacroStep): Promise<void> {
  switch (step.type) {
    case "key":
      await dispatchKeyStep(page, step.code);
      return;
    case "click":
      await dispatchClickStep(page, step.xPercent, step.yPercent);
      return;
    case "delay":
      await wait(step.ms);
      return;
  }
}

async function dispatchKeyStep(page: Page, code: string): Promise<void> {
  await focusAutomationTarget(page);

  const session = await page.context().newCDPSession(page);
  const definition = getKeyDefinition(code);
  const event = {
    code,
    key: definition.key,
    nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
    windowsVirtualKeyCode: definition.windowsVirtualKeyCode
  };

  try {
    await session.send("Input.dispatchKeyEvent", {
      ...event,
      type: "rawKeyDown"
    });
    await session.send("Input.dispatchKeyEvent", {
      ...event,
      type: "keyUp"
    });
  } finally {
    await detachCdpSession(session);
  }
}

async function focusAutomationTarget(page: Page): Promise<void> {
  await page.bringToFront().catch(() => undefined);

  for (const frame of [...page.frames()].reverse()) {
    const result = await frame
      .evaluate(FOCUS_AUTOMATION_TARGET_SCRIPT, { allowFallback: false })
      .catch(() => "");

    if (result === "canvas") {
      return;
    }
  }

  await page.evaluate(FOCUS_AUTOMATION_TARGET_SCRIPT, { allowFallback: true }).catch(() => undefined);
}

const FOCUS_AUTOMATION_TARGET_SCRIPT = ({ allowFallback }: { allowFallback: boolean }): string => {
  function isVisibleElement(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function focusElement(element: Element | null | undefined): boolean {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const hadTabIndex = element.hasAttribute("tabindex");

    if (!hadTabIndex) {
      element.setAttribute("tabindex", "-1");
    }

    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }

    if (!hadTabIndex && element !== document.body) {
      setTimeout(() => {
        element.removeAttribute("tabindex");
      }, 0);
    }

    return document.activeElement === element;
  }

  function getLargestVisibleElement(selector: string): Element | undefined {
    return Array.from(document.querySelectorAll(selector))
      .filter(isVisibleElement)
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
      })[0];
  }

  if (focusElement(getLargestVisibleElement("canvas"))) {
    return "canvas";
  }

  if (!allowFallback) {
    return "";
  }

  if (focusElement(getLargestVisibleElement("iframe"))) {
    return "iframe";
  }

  return focusElement(document.body) ? "body" : "";
};

async function dispatchClickStep(page: Page, xPercent: number, yPercent: number): Promise<void> {
  const viewport = await page.evaluate(() => ({
    height: window.innerHeight,
    width: window.innerWidth
  }));

  const x = Math.round((viewport.width * xPercent) / 100);
  const y = Math.round((viewport.height * yPercent) / 100);

  await page.mouse.click(x, y);
}

async function wait(ms: number): Promise<void> {
  if (ms === 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function detachCdpSession(session: CDPSession): Promise<void> {
  await session.detach().catch(() => undefined);
}

function createRunKey(roleId: string, macroId: string): string {
  return `${roleId}:${macroId}`;
}

function getKeyDefinition(code: string): KeyDefinition {
  if (/^Key[A-Z]$/.test(code)) {
    const letter = code.slice(3);
    return {
      key: letter.toLowerCase(),
      windowsVirtualKeyCode: letter.charCodeAt(0)
    };
  }

  if (/^Digit[0-9]$/.test(code)) {
    const digit = code.slice(5);
    return {
      key: digit,
      windowsVirtualKeyCode: digit.charCodeAt(0)
    };
  }

  if (/^Numpad[0-9]$/.test(code)) {
    const digit = code.slice(6);
    return {
      key: digit,
      windowsVirtualKeyCode: 96 + Number(digit)
    };
  }

  const functionKeyMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (functionKeyMatch) {
    return {
      key: code,
      windowsVirtualKeyCode: 111 + Number(functionKeyMatch[1])
    };
  }

  return namedKeyDefinitions[code] ?? { key: code, windowsVirtualKeyCode: 0 };
}

const namedKeyDefinitions: Record<string, KeyDefinition> = {
  AltLeft: { key: "Alt", windowsVirtualKeyCode: 18 },
  AltRight: { key: "Alt", windowsVirtualKeyCode: 18 },
  ArrowDown: { key: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", windowsVirtualKeyCode: 39 },
  ArrowUp: { key: "ArrowUp", windowsVirtualKeyCode: 38 },
  Backquote: { key: "`", windowsVirtualKeyCode: 192 },
  Backslash: { key: "\\", windowsVirtualKeyCode: 220 },
  Backspace: { key: "Backspace", windowsVirtualKeyCode: 8 },
  BracketLeft: { key: "[", windowsVirtualKeyCode: 219 },
  BracketRight: { key: "]", windowsVirtualKeyCode: 221 },
  Comma: { key: ",", windowsVirtualKeyCode: 188 },
  ControlLeft: { key: "Control", windowsVirtualKeyCode: 17 },
  ControlRight: { key: "Control", windowsVirtualKeyCode: 17 },
  Delete: { key: "Delete", windowsVirtualKeyCode: 46 },
  End: { key: "End", windowsVirtualKeyCode: 35 },
  Enter: { key: "Enter", windowsVirtualKeyCode: 13 },
  Equal: { key: "=", windowsVirtualKeyCode: 187 },
  Escape: { key: "Escape", windowsVirtualKeyCode: 27 },
  Home: { key: "Home", windowsVirtualKeyCode: 36 },
  Insert: { key: "Insert", windowsVirtualKeyCode: 45 },
  MetaLeft: { key: "Meta", windowsVirtualKeyCode: 91 },
  MetaRight: { key: "Meta", windowsVirtualKeyCode: 92 },
  Minus: { key: "-", windowsVirtualKeyCode: 189 },
  NumpadAdd: { key: "+", windowsVirtualKeyCode: 107 },
  NumpadDecimal: { key: ".", windowsVirtualKeyCode: 110 },
  NumpadDivide: { key: "/", windowsVirtualKeyCode: 111 },
  NumpadMultiply: { key: "*", windowsVirtualKeyCode: 106 },
  NumpadSubtract: { key: "-", windowsVirtualKeyCode: 109 },
  PageDown: { key: "PageDown", windowsVirtualKeyCode: 34 },
  PageUp: { key: "PageUp", windowsVirtualKeyCode: 33 },
  Period: { key: ".", windowsVirtualKeyCode: 190 },
  Quote: { key: "'", windowsVirtualKeyCode: 222 },
  Semicolon: { key: ";", windowsVirtualKeyCode: 186 },
  ShiftLeft: { key: "Shift", windowsVirtualKeyCode: 16 },
  ShiftRight: { key: "Shift", windowsVirtualKeyCode: 16 },
  Slash: { key: "/", windowsVirtualKeyCode: 191 },
  Space: { key: " ", windowsVirtualKeyCode: 32 },
  Tab: { key: "Tab", windowsVirtualKeyCode: 9 }
};
