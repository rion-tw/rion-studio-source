import type { BrowserAutomationTarget } from "./ElectronAutomationTarget";
import {
  createMacroShortcutSuppressionClearSource,
  createMacroShortcutSuppressionSource
} from "../../shared/macroShortcuts";
import type { PixelBounds } from "../../shared/types";
import {
  CdpClient,
  listDevToolsTargets,
  waitForDevToolsPort,
  type CdpEventClientLike,
  type DevToolsFetch,
  type DevToolsTarget
} from "../system-browser/SystemChromeLauncher";

const ATTACH_TIMEOUT_MS = 10_000;
const ATTACH_POLL_INTERVAL_MS = 500;
const OVERLAY_BINDING_NAME = "rionStudioMacroOverlay";
const OVERLAY_BRIDGE_KEY = "__rionStudioExternalMacroBridge";

export type ExternalMacroOverlayHandler = (request: unknown) => Promise<unknown>;

export interface ExternalBrowserAutomationTarget extends BrowserAutomationTarget {
  close: () => void;
  installMacroOverlay: (source: string, handler: ExternalMacroOverlayHandler) => Promise<void>;
  onDisconnect: (listener: () => void) => () => void;
  setWindowBounds: (bounds: PixelBounds) => Promise<void>;
}

export interface ConnectExternalChromeAutomationOptions {
  createClient?: (target: DevToolsTarget) => CdpEventClientLike;
  fetch?: DevToolsFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function connectExternalChromeAutomation(
  browserUserDataDir: string,
  launchUrl: string,
  options: ConnectExternalChromeAutomationOptions = {}
): Promise<ExternalChromeAutomationTarget> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + ATTACH_TIMEOUT_MS;
  const portResult = await waitForDevToolsPort(browserUserDataDir, {
    timeoutMs: ATTACH_TIMEOUT_MS,
    pollIntervalMs: ATTACH_POLL_INTERVAL_MS,
    now,
    sleep
  });

  if (portResult.state !== "available") {
    throw new Error(
      "message" in portResult ? portResult.message : "Unable to connect to external Chrome automation."
    );
  }

  let lastError: unknown;
  while (now() < deadline) {
    try {
      const targets = await listDevToolsTargets(portResult.port, options.fetch);
      const target = selectPageTarget(targets, launchUrl);
      if (target?.webSocketDebuggerUrl) {
        const client = (options.createClient ?? createClient)(target);
        const automationTarget = new ExternalChromeAutomationTarget(client);
        await automationTarget.initialize();
        return automationTarget;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(ATTACH_POLL_INTERVAL_MS);
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to find the external Chrome game page.");
}

export class ExternalChromeAutomationTarget implements ExternalBrowserAutomationTarget {
  private readonly executionContextIds = new Set<number>();
  private keyDispatchTail: Promise<void> = Promise.resolve();
  private overlayHandler?: ExternalMacroOverlayHandler;
  private removeNotificationListener?: () => void;

  constructor(private readonly client: CdpEventClientLike) {}

  async initialize(): Promise<void> {
    this.removeNotificationListener = this.client.onNotification((notification) => {
      switch (notification.method) {
        case "Runtime.bindingCalled":
          void this.handleBindingCalled(notification.params);
          break;
        case "Runtime.executionContextCreated": {
          const context = notification.params?.context;
          if (typeof context === "object" && context !== null && "id" in context && typeof context.id === "number") {
            this.executionContextIds.add(context.id);
          }
          break;
        }
        case "Runtime.executionContextDestroyed":
          if (typeof notification.params?.executionContextId === "number") {
            this.executionContextIds.delete(notification.params.executionContextId);
          }
          break;
        case "Runtime.executionContextsCleared":
          this.executionContextIds.clear();
          break;
      }
    });
    try {
      await Promise.all([this.client.send("Page.enable"), this.client.send("Runtime.enable")]);
    } catch (error) {
      this.removeNotificationListener?.();
      this.removeNotificationListener = undefined;
      throw error;
    }
  }

  onDisconnect(listener: () => void): () => void {
    return this.client.onDisconnect(listener);
  }

  close(): void {
    this.removeNotificationListener?.();
    this.removeNotificationListener = undefined;
    this.client.close();
  }

  async setWindowBounds(bounds: PixelBounds): Promise<void> {
    const window = await this.client.send<{
      bounds?: { windowState?: "normal" | "minimized" | "maximized" | "fullscreen" };
      windowId: number;
    }>("Browser.getWindowForTarget");

    if (window.bounds?.windowState && window.bounds.windowState !== "normal") {
      await this.client.send("Browser.setWindowBounds", {
        windowId: window.windowId,
        bounds: { windowState: "normal" }
      });
    }

    await this.client.send("Browser.setWindowBounds", {
      windowId: window.windowId,
      bounds: {
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height
      }
    });
  }

  async focus(): Promise<void> {
    await this.client.send("Page.bringToFront");
    await this.preparePageTarget();
  }

  private async preparePageTarget(): Promise<void> {
    await this.evaluate(createExternalFocusSource()).catch(() => undefined);
  }

  dispatchKey(code: string): Promise<void> {
    const result = this.keyDispatchTail.then(() => this.dispatchKeyUnlocked(code));
    this.keyDispatchTail = result.catch(() => undefined);
    return result;
  }

  private async dispatchKeyUnlocked(code: string): Promise<void> {
    await this.preparePageTarget();
    await this.suppressNextShortcut(code);
    const descriptor = getCdpKeyDescriptor(code);
    try {
      await this.client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...descriptor });
      await this.client.send("Input.dispatchKeyEvent", { type: "keyUp", ...descriptor });
    } finally {
      await this.evaluateInExecutionContexts(createMacroShortcutSuppressionClearSource(code));
    }
  }

  private async suppressNextShortcut(code: string): Promise<void> {
    await this.evaluateInExecutionContexts(createMacroShortcutSuppressionSource(code));
  }

  private async evaluateInExecutionContexts(expression: string): Promise<void> {
    const contextIds = [...this.executionContextIds];

    if (contextIds.length === 0) {
      await this.evaluate(expression).catch(() => undefined);
      return;
    }

    await Promise.all(
      contextIds.map(async (contextId) => {
        try {
          await this.client.send("Runtime.evaluate", { expression, contextId });
        } catch {
          this.executionContextIds.delete(contextId);
        }
      })
    );
  }

  async dispatchClick(xPercent: number, yPercent: number): Promise<void> {
    await this.preparePageTarget();
    const metrics = await this.client.send<{
      cssVisualViewport?: { clientHeight?: number; clientWidth?: number };
    }>("Page.getLayoutMetrics");
    const width = Math.max(1, metrics.cssVisualViewport?.clientWidth ?? 1);
    const height = Math.max(1, metrics.cssVisualViewport?.clientHeight ?? 1);
    const x = clamp(Math.round((width * xPercent) / 100), 0, width - 1);
    const y = clamp(Math.round((height * yPercent) / 100), 0, height - 1);
    await this.client.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x, y });
    await this.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x, y });
  }

  async evaluate<T = unknown>(source: string): Promise<T> {
    const response = await this.client.send<{
      exceptionDetails?: { text?: string };
      result?: { value?: T };
    }>("Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text ?? "External Chrome script failed.");
    }
    return response.result?.value as T;
  }

  async installMacroOverlay(source: string, handler: ExternalMacroOverlayHandler): Promise<void> {
    this.overlayHandler = handler;
    await this.client.send("Runtime.addBinding", { name: OVERLAY_BINDING_NAME });
    const bootstrap = createOverlayBridgeBootstrap();
    await this.client.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap });
    await this.client.send("Page.addScriptToEvaluateOnNewDocument", { source });
    await this.evaluate(bootstrap);
    await this.evaluate(source);
  }

  private async handleBindingCalled(params: Record<string, unknown> | undefined): Promise<void> {
    if (params?.name !== OVERLAY_BINDING_NAME || typeof params.payload !== "string" || !this.overlayHandler) {
      return;
    }

    const contextId = typeof params.executionContextId === "number" ? params.executionContextId : undefined;
    let envelope: { id?: unknown; request?: unknown };
    try {
      envelope = JSON.parse(params.payload) as { id?: unknown; request?: unknown };
    } catch {
      return;
    }
    if (typeof envelope.id !== "number") {
      return;
    }

    try {
      const result = await this.overlayHandler(envelope.request);
      await this.resolveOverlayRequest(envelope.id, true, result, contextId);
    } catch (error) {
      await this.resolveOverlayRequest(
        envelope.id,
        false,
        error instanceof Error ? error.message : "Macro overlay request failed.",
        contextId
      );
    }
  }

  private async resolveOverlayRequest(id: number, ok: boolean, value: unknown, contextId?: number): Promise<void> {
    const expression = `window[${JSON.stringify(OVERLAY_BRIDGE_KEY)}]?.resolve(${JSON.stringify(id)}, ${JSON.stringify(ok)}, ${JSON.stringify(value)})`;
    await this.client.send("Runtime.evaluate", {
      expression,
      ...(contextId === undefined ? {} : { contextId })
    }).catch(() => undefined);
  }
}

function createClient(target: DevToolsTarget): CdpEventClientLike {
  if (!target.webSocketDebuggerUrl) {
    throw new Error("External Chrome page does not expose a DevTools WebSocket URL.");
  }
  return new CdpClient(target.webSocketDebuggerUrl);
}

function selectPageTarget(targets: DevToolsTarget[], launchUrl: string): DevToolsTarget | undefined {
  const pageTargets = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  return pageTargets.find((target) => target.url === launchUrl) ??
    pageTargets.find((target) => sameOrigin(target.url, launchUrl));
}

function sameOrigin(value: string | undefined, expected: string): boolean {
  try {
    return Boolean(value) && new URL(value!).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

function createOverlayBridgeBootstrap(): string {
  return `(() => {
    const bindingName = ${JSON.stringify(OVERLAY_BINDING_NAME)};
    const bridgeKey = ${JSON.stringify(OVERLAY_BRIDGE_KEY)};
    if (window[bridgeKey]?.version === 1 || typeof window[bindingName] !== "function") return;
    const nativeBinding = window[bindingName];
    let nextId = 1;
    const pending = new Map();
    window[bridgeKey] = {
      version: 1,
      resolve(id, ok, value) {
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (ok) request.resolve(value);
        else request.reject(new Error(String(value)));
      }
    };
    window[bindingName] = (request) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      nativeBinding(JSON.stringify({ id, request }));
    });
  })()`;
}

function createExternalFocusSource(): string {
  return `(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const target = [...document.querySelectorAll("canvas, iframe")]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0] || document.body;
    if (!(target instanceof HTMLElement)) return false;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    try { target.focus({ preventScroll: true }); } catch { target.focus(); }
    return document.activeElement === target;
  })()`;
}

export function getCdpKeyDescriptor(code: string): Record<string, string | number> {
  const key = code.startsWith("Key") && code.length === 4
    ? code.slice(3).toLowerCase()
    : code.startsWith("Digit") && code.length === 6
      ? code.slice(5)
      : cdpKeys[code] ?? code;
  const windowsVirtualKeyCode = getWindowsVirtualKeyCode(code, key);
  return { code, key, ...(windowsVirtualKeyCode === undefined ? {} : { windowsVirtualKeyCode }) };
}

function getWindowsVirtualKeyCode(code: string, key: string): number | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return 111 + Number(code.slice(1));
  return virtualKeyCodes[code] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const cdpKeys: Record<string, string> = {
  ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp",
  Backspace: "Backspace", Enter: "Enter", Equal: "=", Escape: "Escape", Minus: "-", Space: " ", Tab: "Tab",
  NumpadAdd: "+", NumpadDecimal: ".", NumpadDivide: "/", NumpadMultiply: "*", NumpadSubtract: "-"
};

const virtualKeyCodes: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Space: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Equal: 187, Minus: 189,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111
};
