import type { BrowserAutomationTarget } from "./ElectronAutomationTarget";
import {
  createMacroShortcutSuppressionClearSource,
  createMacroShortcutSuppressionSource
} from "../../shared/macroShortcuts";
import type { PixelBounds } from "../../shared/types";
import type { WorkspaceCpuThrottleRate } from "../../shared/types";
import {
  createCdnCompatibilityRequestPatterns,
  rewriteCdnCompatibilityUrl
} from "../game-browser/CdnCompatibilityManager";
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
const FOCUS_BINDING_NAME = "rionStudioWindowFocus";
const FOCUS_TRACKER_KEY = "__rionStudioWindowFocusTracker";
const POINTER_FOCUS_STATE_KEY = "__rionStudioPointerFocusState";

export type ExternalMacroOverlayHandler = (request: unknown) => Promise<unknown>;

export interface ExternalBrowserAutomationTarget extends BrowserAutomationTarget {
  close: () => void;
  installMacroOverlay: (source: string, handler: ExternalMacroOverlayHandler) => Promise<void>;
  onFocus: (listener: () => void) => () => void;
  onDisconnect: (listener: () => void) => () => void;
  releaseThrottle: () => Promise<void>;
  setCpuThrottleRate: (rate: 1 | WorkspaceCpuThrottleRate) => Promise<void>;
  setWindowBounds: (bounds: PixelBounds) => Promise<void>;
}

export interface ConnectExternalChromeAutomationOptions {
  cdnCompatibilityEnabled?: boolean;
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

  const deadline = now() + ATTACH_TIMEOUT_MS;
  let lastError: unknown;
  while (now() < deadline) {
    try {
      const targets = await listDevToolsTargets(portResult.port, options.fetch);
      const target = selectPageTarget(targets, launchUrl);
      if (target?.webSocketDebuggerUrl) {
        const client = (options.createClient ?? createClient)(target);
        const automationTarget = new ExternalChromeAutomationTarget(client);
        try {
          await automationTarget.initialize({ cdnCompatibilityEnabled: options.cdnCompatibilityEnabled });
          return automationTarget;
        } catch (error) {
          automationTarget.close();
          throw error;
        }
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
  private readonly iframeSessionIds = new Set<string>();
  private inputDispatchTail: Promise<void> = Promise.resolve();
  private mainFrameId?: string;
  private overlayHandler?: ExternalMacroOverlayHandler;
  private pointerFocusTrackingInstalled = false;
  private removeNotificationListener?: () => void;
  private readonly focusListeners = new Set<() => void>();
  private currentCpuThrottleRate: 1 | WorkspaceCpuThrottleRate = 1;
  private desiredCpuThrottleRate: 1 | WorkspaceCpuThrottleRate = 1;
  private resourceControlPromise?: Promise<void>;

  constructor(private readonly client: CdpEventClientLike) {}

  async initialize(options: { cdnCompatibilityEnabled?: boolean } = {}): Promise<void> {
    this.removeNotificationListener = this.client.onNotification((notification) => {
      switch (notification.method) {
        case "Fetch.requestPaused":
          void this.handleCdnRequestPaused(notification.params);
          break;
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
        case "Target.attachedToTarget":
          this.handleTargetAttached(notification.params);
          break;
        case "Target.detachedFromTarget":
          if (typeof notification.params?.sessionId === "string") {
            this.iframeSessionIds.delete(notification.params.sessionId);
          }
          break;
      }
    });
    try {
      await Promise.all([this.client.send("Page.enable"), this.client.send("Runtime.enable")]);
      if (options.cdnCompatibilityEnabled) {
        await this.enableCdnCompatibility();
      }
    } catch (error) {
      this.removeNotificationListener?.();
      this.removeNotificationListener = undefined;
      throw error;
    }
  }

  onDisconnect(listener: () => void): () => void {
    return this.client.onDisconnect(listener);
  }

  onFocus(listener: () => void): () => void {
    this.focusListeners.add(listener);
    void this.prepareResourceControl().catch(() => undefined);
    return () => this.focusListeners.delete(listener);
  }

  close(): void {
    this.removeNotificationListener?.();
    this.removeNotificationListener = undefined;
    this.client.close();
  }

  async setCpuThrottleRate(rate: 1 | WorkspaceCpuThrottleRate): Promise<void> {
    await this.prepareResourceControl();
    if (this.currentCpuThrottleRate === rate) {
      return;
    }
    this.desiredCpuThrottleRate = rate;
    try {
      await Promise.all([
        this.client.send("Emulation.setCPUThrottlingRate", { rate }),
        ...[...this.iframeSessionIds].map((sessionId) =>
          this.client.send("Emulation.setCPUThrottlingRate", { rate }, undefined, sessionId)
        )
      ]);
      this.currentCpuThrottleRate = rate;
    } catch (error) {
      this.desiredCpuThrottleRate = this.currentCpuThrottleRate;
      throw error;
    }
  }

  async releaseThrottle(): Promise<void> {
    if (this.currentCpuThrottleRate === 1) {
      return;
    }
    await this.setCpuThrottleRate(1);
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
    await this.focusPageTarget();
  }

  async ensureInputFocus(): Promise<boolean> {
    return Boolean(
      await this.evaluate(createExternalFocusSource(false)).catch(() => false)
    );
  }

  private async focusPageTarget(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.evaluate(createExternalFocusSource(true)).catch(() => undefined);
    signal?.throwIfAborted();
  }

  dispatchKey(code: string, signal?: AbortSignal): Promise<void> {
    return this.enqueueInput(() => this.dispatchKeyUnlocked(code, signal));
  }

  private async dispatchKeyUnlocked(code: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.suppressNextShortcut(code);
    const descriptor = getCdpKeyDescriptor(code);
    let didSendKeyDown = false;
    let didSendKeyUp = false;
    try {
      signal?.throwIfAborted();
      await this.client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...descriptor });
      didSendKeyDown = true;
      signal?.throwIfAborted();
      await this.client.send("Input.dispatchKeyEvent", { type: "keyUp", ...descriptor });
      didSendKeyUp = true;
    } finally {
      if (didSendKeyDown && !didSendKeyUp) {
        await this.client.send("Input.dispatchKeyEvent", { type: "keyUp", ...descriptor }).catch(() => undefined);
      }
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

  dispatchClick(xPercent: number, yPercent: number, signal?: AbortSignal): Promise<void> {
    return this.enqueueInput(() => this.dispatchClickUnlocked(xPercent, yPercent, signal));
  }

  private async dispatchClickUnlocked(xPercent: number, yPercent: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const metrics = await this.client.send<{
      cssVisualViewport?: { clientHeight?: number; clientWidth?: number };
    }>("Page.getLayoutMetrics");
    signal?.throwIfAborted();
    const width = Math.max(1, metrics.cssVisualViewport?.clientWidth ?? 1);
    const height = Math.max(1, metrics.cssVisualViewport?.clientHeight ?? 1);
    const x = clamp(Math.round((width * xPercent) / 100), 0, width - 1);
    const y = clamp(Math.round((height * yPercent) / 100), 0, height - 1);
    const release = { type: "mouseReleased", button: "left", clickCount: 1, x, y };
    let didPress = false;
    let didRelease = false;
    if (this.pointerFocusTrackingInstalled) {
      await this.evaluateInExecutionContexts(createPointerFocusSuppressionSource(true));
    }
    try {
      await this.client.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x, y });
      didPress = true;
      signal?.throwIfAborted();
      await this.client.send("Input.dispatchMouseEvent", release);
      didRelease = true;
    } finally {
      if (didPress && !didRelease) {
        await this.client.send("Input.dispatchMouseEvent", release).catch(() => undefined);
      }
      if (this.pointerFocusTrackingInstalled) {
        await this.evaluateInExecutionContexts(createPointerFocusSuppressionSource(false));
      }
    }
  }

  private enqueueInput(operation: () => Promise<void>): Promise<void> {
    const result = this.inputDispatchTail.then(operation);
    this.inputDispatchTail = result.catch(() => undefined);
    return result;
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
    const pointerFocusTracking = createExternalPointerFocusTrackingSource();
    await this.client.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap });
    await this.client.send("Page.addScriptToEvaluateOnNewDocument", { source: pointerFocusTracking });
    await this.client.send("Page.addScriptToEvaluateOnNewDocument", { source });
    await this.evaluate(bootstrap);
    await this.evaluate(pointerFocusTracking);
    this.pointerFocusTrackingInstalled = true;
    await this.evaluate(source);
  }

  private async enableCdnCompatibility(): Promise<void> {
    const frameTree = await this.client.send<{
      frameTree?: { frame?: { id?: string } };
    }>("Page.getFrameTree");
    const mainFrameId = frameTree.frameTree?.frame?.id;
    if (!mainFrameId) {
      throw new Error("External Chrome main frame is unavailable for CDN compatibility.");
    }

    this.mainFrameId = mainFrameId;
    await this.client.send("Fetch.enable", {
      patterns: createCdnCompatibilityRequestPatterns()
    });
    await this.client.send("Page.reload", { ignoreCache: true });
  }

  private async handleCdnRequestPaused(params: Record<string, unknown> | undefined): Promise<void> {
    if (!params || typeof params.requestId !== "string") {
      return;
    }

    const requestId = params.requestId;
    const request = isRecord(params.request) ? params.request : undefined;
    const url = typeof request?.url === "string" ? request.url : undefined;
    const isMainFrameDocument =
      params.resourceType === "Document" &&
      (typeof params.frameId !== "string" || params.frameId === this.mainFrameId);
    const redirectUrl = !isMainFrameDocument && url ? rewriteCdnCompatibilityUrl(url) : undefined;

    await this.client.send("Fetch.continueRequest", {
      requestId,
      ...(redirectUrl ? { url: redirectUrl } : {})
    }).catch(() => undefined);
  }

  private async handleBindingCalled(params: Record<string, unknown> | undefined): Promise<void> {
    if (params?.name === FOCUS_BINDING_NAME) {
      if (params.payload === "focused") {
        this.focusListeners.forEach((listener) => listener());
      }
      return;
    }
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

  private async installFocusTracking(): Promise<void> {
    const source = createFocusTrackingSource();
    await this.client.send("Runtime.addBinding", { name: FOCUS_BINDING_NAME });
    await this.client.send("Page.addScriptToEvaluateOnNewDocument", { source });
    await this.evaluate(source);
  }

  private prepareResourceControl(): Promise<void> {
    this.resourceControlPromise ??= Promise.all([
      this.client.send("Target.setAutoAttach", {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: false
      }),
      this.installFocusTracking()
    ]).then(() => undefined);
    return this.resourceControlPromise;
  }

  private handleTargetAttached(params: Record<string, unknown> | undefined): void {
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined;
    const targetInfo = isRecord(params?.targetInfo) ? params.targetInfo : undefined;
    if (!sessionId || targetInfo?.type !== "iframe") {
      return;
    }

    this.iframeSessionIds.add(sessionId);
    void this.client.send(
      "Emulation.setCPUThrottlingRate",
      { rate: this.desiredCpuThrottleRate },
      undefined,
      sessionId
    ).catch(() => {
      this.iframeSessionIds.delete(sessionId);
    });
  }
}

function createClient(target: DevToolsTarget): CdpEventClientLike {
  if (!target.webSocketDebuggerUrl) {
    throw new Error("External Chrome page does not expose a DevTools WebSocket URL.");
  }
  return new CdpClient(target.webSocketDebuggerUrl);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function createExternalFocusSource(allowBodyFallback: boolean): string {
  return `(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const target = [...document.querySelectorAll("canvas, iframe")]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0] || (${JSON.stringify(allowBodyFallback)} ? document.body : null);
    if (!(target instanceof HTMLElement)) return false;
    if (document.activeElement === target) return true;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    try { target.focus({ preventScroll: true }); } catch { target.focus(); }
    return document.activeElement === target;
  })()`;
}

function createExternalPointerFocusTrackingSource(): string {
  return `(() => {
    const key = ${JSON.stringify(POINTER_FOCUS_STATE_KEY)};
    if (window[key]?.version === 1) return;
    const state = {
      suppressionDepth: 0,
      version: 1,
      setSuppressed(suppressed) {
        state.suppressionDepth = Math.max(0, state.suppressionDepth + (suppressed ? 1 : -1));
      }
    };
    window[key] = state;
    window.addEventListener("pointerdown", (event) => {
      if (state.suppressionDepth > 0 || event.button !== 0) return;
      const canvas = event.composedPath().find((item) => item instanceof HTMLCanvasElement);
      if (!(canvas instanceof HTMLCanvasElement) || document.activeElement === canvas) return;
      const hadTabIndex = canvas.hasAttribute("tabindex");
      if (!hadTabIndex) canvas.setAttribute("tabindex", "-1");
      try { canvas.focus({ preventScroll: true }); } catch { canvas.focus(); }
      if (!hadTabIndex) setTimeout(() => canvas.removeAttribute("tabindex"), 0);
    }, true);
  })()`;
}

function createPointerFocusSuppressionSource(suppressed: boolean): string {
  return `window[${JSON.stringify(POINTER_FOCUS_STATE_KEY)}]?.setSuppressed?.(${JSON.stringify(suppressed)})`;
}

function createFocusTrackingSource(): string {
  return `(() => {
    const key = ${JSON.stringify(FOCUS_TRACKER_KEY)};
    const bindingName = ${JSON.stringify(FOCUS_BINDING_NAME)};
    if (window[key] || typeof window[bindingName] !== "function") return;
    window[key] = true;
    const reportFocus = () => window[bindingName]("focused");
    window.addEventListener("focus", reportFocus, true);
    if (document.hasFocus()) reportFocus();
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
