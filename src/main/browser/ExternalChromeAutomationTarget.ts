import {
  waitForInputDelay,
  type BrowserAutomationTarget,
  type BrowserInputDispatchOptions
} from "./ElectronAutomationTarget";
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
import type { PixelBounds } from "../../shared/types";
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
const DIAGNOSTICS_BINDING_NAME = "rionStudioExternalDiagnostics";
const DIAGNOSTICS_STATE_KEY = "__rionStudioExternalDiagnosticsV1";

export type ExternalMacroOverlayHandler = (request: unknown) => Promise<unknown>;

export interface ExternalChromeDiagnosticEvent {
  details: Record<string, unknown>;
  type: "browser_version" | "cdp_evaluate_failed" | "cdp_recovered" | "disconnect" | "page_lifecycle";
}

export interface ExternalBrowserAutomationTarget extends BrowserAutomationTarget {
  close: () => void;
  installMacroOverlay: (source: string, handler: ExternalMacroOverlayHandler) => Promise<void>;
  onDisconnect: (listener: () => void) => () => void;
  onNavigation: (listener: () => void) => () => void;
  setWindowBounds: (bounds: PixelBounds) => Promise<void>;
}

export interface ConnectExternalChromeAutomationOptions {
  cdnCompatibilityEnabled?: boolean;
  createClient?: (target: DevToolsTarget) => CdpEventClientLike;
  fetch?: DevToolsFetch;
  now?: () => number;
  onDiagnostic?: (event: ExternalChromeDiagnosticEvent) => void;
  platform?: NodeJS.Platform;
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
        const automationTarget = new ExternalChromeAutomationTarget(
          client,
          options.platform ?? "linux",
          options.onDiagnostic
        );
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
  private readonly heldKeyOwners = new Map<string, Set<string>>();
  private inputDispatchTail: Promise<void> = Promise.resolve();
  private mainFrameId?: string;
  private readonly navigationListeners = new Set<() => void>();
  private overlayHandler?: ExternalMacroOverlayHandler;
  private removeNotificationListener?: () => void;
  private removeDiagnosticDisconnectListener?: () => void;
  private consecutiveEvaluateFailures = 0;
  private lastSuccessfulCdpReplyAt?: string;

  constructor(
    private readonly client: CdpEventClientLike,
    private readonly platform: NodeJS.Platform = "linux",
    private readonly onDiagnostic?: (event: ExternalChromeDiagnosticEvent) => void
  ) {}

  async initialize(options: { cdnCompatibilityEnabled?: boolean } = {}): Promise<void> {
    this.removeNotificationListener = this.client.onNotification((notification) => {
      switch (notification.method) {
        case "Fetch.requestPaused":
          void this.handleCdnRequestPaused(notification.params);
          break;
        case "Runtime.bindingCalled":
          if (notification.params?.name === DIAGNOSTICS_BINDING_NAME) {
            this.handleDiagnosticBindingCalled(notification.params);
          } else {
            void this.handleBindingCalled(notification.params);
          }
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
        case "Page.frameNavigated": {
          const frame = notification.params?.frame;
          if (
            typeof frame === "object" &&
            frame !== null &&
            "id" in frame &&
            typeof frame.id === "string" &&
            (!("parentId" in frame) || frame.parentId === undefined)
          ) {
            this.mainFrameId = frame.id;
            this.navigationListeners.forEach((listener) => listener());
          }
          break;
        }
        case "Page.lifecycleEvent":
          if (notification.params?.name === "frozen" || notification.params?.name === "resumed") {
            this.emitDiagnostic("page_lifecycle", {
              event: notification.params.name,
              source: "cdp"
            });
          }
          break;
      }
    });
    this.removeDiagnosticDisconnectListener = this.client.onDisconnect(() => {
      this.emitDiagnostic("disconnect", {
        consecutiveEvaluateFailures: this.consecutiveEvaluateFailures,
        lastSuccessfulCdpReplyAt: this.lastSuccessfulCdpReplyAt,
        reason: "devtools_websocket_disconnected"
      });
    });
    try {
      await Promise.all([this.client.send("Page.enable"), this.client.send("Runtime.enable")]);
      await this.client.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => undefined);
      await this.installPageDiagnostics().catch(() => undefined);
      await this.recordBrowserVersion().catch(() => undefined);
      if (options.cdnCompatibilityEnabled) {
        await this.enableCdnCompatibility();
      }
    } catch (error) {
      this.removeNotificationListener?.();
      this.removeNotificationListener = undefined;
      this.removeDiagnosticDisconnectListener?.();
      this.removeDiagnosticDisconnectListener = undefined;
      throw error;
    }
  }

  onDisconnect(listener: () => void): () => void {
    return this.client.onDisconnect(listener);
  }

  onNavigation(listener: () => void): () => void {
    this.navigationListeners.add(listener);
    return () => this.navigationListeners.delete(listener);
  }

  close(): void {
    this.removeNotificationListener?.();
    this.removeNotificationListener = undefined;
    this.removeDiagnosticDisconnectListener?.();
    this.removeDiagnosticDisconnectListener = undefined;
    this.navigationListeners.clear();
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
      for (const pressedCode of [...pressedCodes].reverse()) {
        if (pressedCode === code) {
          await this.suppressShortcutPhase(code, "keyup").catch(() => undefined);
        }
        activeCodes.delete(pressedCode);
        await this.sendKeyUp(pressedCode, activeCodes).catch(() => undefined);
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

    if (suppressShortcut) {
      await this.suppressShortcutPhase(code, "keyup").catch(() => undefined);
    }
    try {
      await this.sendKeyUp(code, new Set(this.heldKeyOwners.keys()));
    } catch (error) {
      if ((this.heldKeyOwners.get(code)?.size ?? 0) > 0) return;
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

  private sendKeyDown(
    code: string,
    activeCodes: ReadonlySet<string>,
    autoRepeat = false
  ): Promise<unknown> {
    const modifiers = getCdpModifierMask(activeCodes);
    return this.client.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...(autoRepeat ? { autoRepeat: true } : {}),
      ...getCdpKeyDescriptor(code, modifiers),
      ...(modifiers > 0 ? { modifiers } : {})
    });
  }

  private sendKeyUp(code: string, activeCodes: ReadonlySet<string>): Promise<unknown> {
    const modifiers = getCdpModifierMask(activeCodes);
    return this.client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      ...getCdpKeyDescriptor(code, modifiers),
      ...(modifiers > 0 ? { modifiers } : {})
    });
  }

  private suppressShortcutPhase(code: string, phase: "keydown" | "keyup"): Promise<void> {
    return this.evaluateInExecutionContexts(
      createMacroShortcutPhaseSuppressionSource(code, phase)
    );
  }

  private clearShortcutPhase(code: string, phase: "keydown" | "keyup"): Promise<void> {
    return this.evaluateInExecutionContexts(
      createMacroShortcutPhaseSuppressionClearSource(code, phase)
    );
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
    }
    await waitForInputDelay(postDelayMs, signal);
  }

  private async dispatchClickPixelsUnlocked(
    xPx: number,
    yPx: number,
    options: BrowserInputDispatchOptions
  ): Promise<void> {
    const { postDelayMs = 0, signal } = options;
    signal?.throwIfAborted();
    const metrics = await this.client.send<{
      cssVisualViewport?: { clientHeight?: number; clientWidth?: number };
    }>("Page.getLayoutMetrics");
    const width = Math.max(1, metrics.cssVisualViewport?.clientWidth ?? 1);
    const height = Math.max(1, metrics.cssVisualViewport?.clientHeight ?? 1);
    const x = Math.max(0, Math.min(width - 1, Math.round(xPx)));
    const y = Math.max(0, Math.min(height - 1, Math.round(yPx)));
    const release = { type: "mouseReleased", button: "left", clickCount: 1, x, y };
    let didPress = false;
    let didRelease = false;
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
    }
    await waitForInputDelay(postDelayMs, signal);
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
    const metrics = await this.client.send<{
      cssVisualViewport?: { clientHeight?: number; clientWidth?: number };
    }>("Page.getLayoutMetrics");
    signal?.throwIfAborted();
    const width = Math.max(1, metrics.cssVisualViewport?.clientWidth ?? 1);
    const height = Math.max(1, metrics.cssVisualViewport?.clientHeight ?? 1);
    const resolved = resolveMacroClickOffset(
      { anchor, unit, x: xOffset, y: yOffset },
      { height, width }
    );
    const x = clamp(
      Math.round(unit === "percent" ? (width * resolved.x) / 100 : resolved.x),
      0,
      width - 1
    );
    const y = clamp(
      Math.round(unit === "percent" ? (height * resolved.y) / 100 : resolved.y),
      0,
      height - 1
    );
    const release = { type: "mouseReleased", button: "left", clickCount: 1, x, y };
    let didPress = false;
    let didRelease = false;
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
    }
    await waitForInputDelay(postDelayMs, signal);
  }

  private enqueueInput(operation: () => Promise<void>): Promise<void> {
    const result = this.inputDispatchTail.then(operation);
    this.inputDispatchTail = result.catch(() => undefined);
    return result;
  }

  async evaluate<T = unknown>(source: string): Promise<T> {
    try {
      const response = await this.client.send<{
        exceptionDetails?: { text?: string };
        result?: { value?: T };
      }>("Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text ?? "External Chrome script failed.");
      }
      const recoveredFailureCount = this.consecutiveEvaluateFailures;
      this.consecutiveEvaluateFailures = 0;
      this.lastSuccessfulCdpReplyAt = new Date().toISOString();
      if (recoveredFailureCount > 0) {
        this.emitDiagnostic("cdp_recovered", {
          failureCount: recoveredFailureCount,
          lastSuccessfulCdpReplyAt: this.lastSuccessfulCdpReplyAt
        });
      }
      return response.result?.value as T;
    } catch (error) {
      this.consecutiveEvaluateFailures += 1;
      this.emitDiagnostic("cdp_evaluate_failed", {
        code: isRecord(error) && typeof error.code === "string" ? error.code : undefined,
        consecutiveFailures: this.consecutiveEvaluateFailures,
        lastSuccessfulCdpReplyAt: this.lastSuccessfulCdpReplyAt,
        message: error instanceof Error ? error.message : "External Chrome evaluation failed."
      });
      throw error;
    }
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

  private async installPageDiagnostics(): Promise<void> {
    const source = createExternalPageDiagnosticsSource();
    await this.client.send("Runtime.addBinding", { name: DIAGNOSTICS_BINDING_NAME });
    await this.client.send("Page.addScriptToEvaluateOnNewDocument", { source });
    await this.evaluate(source);
  }

  private async recordBrowserVersion(): Promise<void> {
    const version = await this.client.send<Record<string, unknown>>("Browser.getVersion");
    this.emitDiagnostic("browser_version", {
      jsVersion: version.jsVersion,
      product: version.product,
      protocolVersion: version.protocolVersion,
      revision: version.revision,
      userAgent: version.userAgent
    });
  }

  private handleDiagnosticBindingCalled(params: Record<string, unknown>): void {
    if (typeof params.payload !== "string") {
      return;
    }
    try {
      const payload = JSON.parse(params.payload) as unknown;
      if (!isRecord(payload) || typeof payload.event !== "string") {
        return;
      }
      this.emitDiagnostic("page_lifecycle", {
        event: payload.event,
        hasFocus: typeof payload.hasFocus === "boolean" ? payload.hasFocus : undefined,
        hidden: typeof payload.hidden === "boolean" ? payload.hidden : undefined,
        source: "page",
        visibilityState: typeof payload.visibilityState === "string" ? payload.visibilityState : undefined,
        wasDiscarded: typeof payload.wasDiscarded === "boolean" ? payload.wasDiscarded : undefined,
        webglRenderer: typeof payload.webglRenderer === "string" ? payload.webglRenderer : undefined,
        webglVendor: typeof payload.webglVendor === "string" ? payload.webglVendor : undefined
      });
    } catch {
      // Ignore malformed diagnostics from the inspected page.
    }
  }

  private emitDiagnostic(type: ExternalChromeDiagnosticEvent["type"], details: Record<string, unknown>): void {
    this.onDiagnostic?.({ details, type });
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

function createExternalPageDiagnosticsSource(): string {
  return `(() => {
    const bindingName = ${JSON.stringify(DIAGNOSTICS_BINDING_NAME)};
    const stateKey = ${JSON.stringify(DIAGNOSTICS_STATE_KEY)};
    if (window.top !== window || typeof window[bindingName] !== "function") return;
    if (window[stateKey]?.version === 1) {
      window[stateKey].report("reinstall");
      return;
    }
    const binding = window[bindingName];
    const graphics = (() => {
      try {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
        const extension = context?.getExtension("WEBGL_debug_renderer_info");
        return extension ? {
          webglRenderer: String(context.getParameter(extension.UNMASKED_RENDERER_WEBGL) || ""),
          webglVendor: String(context.getParameter(extension.UNMASKED_VENDOR_WEBGL) || "")
        } : {};
      } catch { return {}; }
    })();
    const report = (event) => {
      try {
        binding(JSON.stringify({
          event,
          hasFocus: document.hasFocus(),
          hidden: document.hidden,
          visibilityState: document.visibilityState,
          wasDiscarded: Boolean(document.wasDiscarded),
          ...(event === "install" || event === "reinstall" ? graphics : {})
        }));
      } catch {}
    };
    window[stateKey] = { report, version: 1 };
    ["focus", "blur", "pageshow", "pagehide"].forEach((event) => {
      window.addEventListener(event, () => report(event), true);
    });
    ["freeze", "resume"].forEach((event) => {
      document.addEventListener(event, () => report(event), true);
    });
    document.addEventListener("visibilitychange", () => report("visibilitychange"), true);
    report("install");
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

export { getCdpKeyDescriptor };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toMacroKeyInput(input: MacroKeyInput | string): MacroKeyInput {
  return typeof input === "string" ? { code: input } : input;
}
