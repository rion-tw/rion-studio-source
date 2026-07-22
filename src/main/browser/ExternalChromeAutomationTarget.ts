import type { CdpEventClientLike } from "./ExternalChromeCdpBridge";

const OVERLAY_BINDING_NAME = "rionStudioMacroOverlay";
const OVERLAY_BRIDGE_KEY = "__rionStudioExternalMacroBridge";
const DIAGNOSTICS_BINDING_NAME = "rionStudioExternalDiagnostics";
const DIAGNOSTICS_STATE_KEY = "__rionStudioExternalDiagnosticsV2";

export type ExternalMacroOverlayHandler = (request: unknown) => Promise<unknown>;

export interface ExternalChromeDiagnosticEvent {
  details: Record<string, unknown>;
  type:
    | "browser_version"
    | "cdp_evaluate_failed"
    | "cdp_recovered"
    | "cdp_round_trip_timeout"
    | "disconnect"
    | "page_heartbeat"
    | "page_lifecycle";
}

export interface ExternalChromePageDiagnostics {
  capturedAt: string;
  cdp: {
    consecutiveEvaluateFailures: number;
    lastSuccessfulCdpReplyAt?: string;
  };
  page?: {
    fullscreen: boolean;
    hasFocus: boolean;
    hidden: boolean;
    monotonicMs: number;
    visibilityState: string;
  };
  performanceMetrics?: Record<string, number>;
  window?: {
    height?: number;
    width?: number;
    windowState?: string;
  };
  errors?: string[];
}

/** Only the remote-page overlay bridge remains in TypeScript. */
export interface ExternalBrowserAutomationTarget {
  close: () => void;
  evaluate: <T = unknown>(source: string) => Promise<T>;
  installMacroOverlay: (source: string, handler: ExternalMacroOverlayHandler) => Promise<void>;
  onDisconnect: (listener: () => void) => () => void;
  onNavigation: (listener: () => void) => () => void;
}

export interface ConnectExternalChromeAutomationOptions {
  cdnCompatibilityEnabled?: boolean;
  connectClient: (
    browserUserDataDir: string,
    launchUrl: string,
    roleId?: string,
    cdnCompatibilityEnabled?: boolean
  ) => Promise<CdpEventClientLike>;
  onDiagnostic?: (event: ExternalChromeDiagnosticEvent) => void;
  roleId?: string;
}

export async function connectExternalChromeAutomation(
  browserUserDataDir: string,
  launchUrl: string,
  options: ConnectExternalChromeAutomationOptions
): Promise<ExternalChromeAutomationTarget> {
  const client = await options.connectClient(
    browserUserDataDir,
    launchUrl,
    options.roleId,
    options.cdnCompatibilityEnabled
  );
  const target = new ExternalChromeAutomationTarget(client, options.onDiagnostic);
  try {
    await target.initialize();
    return target;
  } catch (error) {
    target.close();
    throw error;
  }
}

export class ExternalChromeAutomationTarget implements ExternalBrowserAutomationTarget {
  private consecutiveEvaluateFailures = 0;
  private lastSuccessfulCdpReplyAt?: string;
  private readonly navigationListeners = new Set<() => void>();
  private overlayHandler?: ExternalMacroOverlayHandler;
  private removeDiagnosticDisconnectListener?: () => void;
  private removeNotificationListener?: () => void;

  constructor(
    private readonly client: CdpEventClientLike,
    private readonly onDiagnostic?: (event: ExternalChromeDiagnosticEvent) => void
  ) {}

  async initialize(): Promise<void> {
    this.removeNotificationListener = this.client.onNotification((notification) => {
      if (notification.method === "Runtime.bindingCalled") {
        if (notification.params?.name === DIAGNOSTICS_BINDING_NAME) {
          this.handleDiagnosticBindingCalled(notification.params);
        } else {
          void this.handleOverlayBindingCalled(notification.params);
        }
        return;
      }
      if (notification.method === "Page.frameNavigated") {
        const frame = notification.params?.frame;
        if (isRecord(frame) && typeof frame.id === "string" && frame.parentId === undefined) {
          this.navigationListeners.forEach((listener) => listener());
        }
        return;
      }
      if (
        notification.method === "Page.lifecycleEvent" &&
        (notification.params?.name === "frozen" || notification.params?.name === "resumed")
      ) {
        this.emitDiagnostic("page_lifecycle", {
          event: notification.params.name,
          source: "cdp"
        });
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
      await Promise.all([
        this.client.send("Page.enable"),
        this.client.send("Runtime.enable")
      ]);
      await this.client.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => undefined);
      await this.installPageDiagnostics().catch(() => undefined);
      await this.recordBrowserVersion().catch(() => undefined);
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

  async evaluate<T = unknown>(source: string): Promise<T> {
    try {
      const response = await this.client.send<{
        exceptionDetails?: unknown;
        result?: { value?: unknown };
      }>("Runtime.evaluate", {
        expression: source,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      });
      if (response.exceptionDetails) {
        throw new Error("External Chrome evaluation failed.");
      }
      const recovered = this.consecutiveEvaluateFailures > 0;
      this.consecutiveEvaluateFailures = 0;
      this.lastSuccessfulCdpReplyAt = new Date().toISOString();
      if (recovered) {
        this.emitDiagnostic("cdp_recovered", {
          lastSuccessfulCdpReplyAt: this.lastSuccessfulCdpReplyAt
        });
      }
      return response.result?.value as T;
    } catch (error) {
      this.consecutiveEvaluateFailures += 1;
      this.emitDiagnostic("cdp_evaluate_failed", {
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

  private async handleOverlayBindingCalled(params: Record<string, unknown> | undefined): Promise<void> {
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
    if (typeof envelope.id !== "number") return;
    try {
      await this.resolveOverlayRequest(
        envelope.id,
        true,
        await this.overlayHandler(envelope.request),
        contextId
      );
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
    if (typeof params.payload !== "string") return;
    try {
      const payload = JSON.parse(params.payload) as unknown;
      if (!isRecord(payload) || typeof payload.event !== "string") return;
      this.emitDiagnostic("page_lifecycle", {
        event: payload.event,
        hasFocus: typeof payload.hasFocus === "boolean" ? payload.hasFocus : undefined,
        hidden: typeof payload.hidden === "boolean" ? payload.hidden : undefined,
        monotonicMs: typeof payload.monotonicMs === "number" ? payload.monotonicMs : undefined,
        sequence: typeof payload.sequence === "number" ? payload.sequence : undefined,
        source: "page",
        visibilityState: typeof payload.visibilityState === "string" ? payload.visibilityState : undefined,
        wasDiscarded: typeof payload.wasDiscarded === "boolean" ? payload.wasDiscarded : undefined,
        webglRenderer: typeof payload.webglRenderer === "string" ? payload.webglRenderer : undefined,
        webglVendor: typeof payload.webglVendor === "string" ? payload.webglVendor : undefined
      });
    } catch {
      // Ignore malformed diagnostics emitted by the inspected page.
    }
  }

  private async resolveOverlayRequest(
    id: number,
    ok: boolean,
    value: unknown,
    contextId?: number
  ): Promise<void> {
    const expression = `window[${JSON.stringify(OVERLAY_BRIDGE_KEY)}]?.resolve(${JSON.stringify(id)}, ${JSON.stringify(ok)}, ${JSON.stringify(value)})`;
    await this.client.send("Runtime.evaluate", {
      expression,
      ...(contextId === undefined ? {} : { contextId })
    }).catch(() => undefined);
  }

  private emitDiagnostic(
    type: ExternalChromeDiagnosticEvent["type"],
    details: Record<string, unknown>
  ): void {
    this.onDiagnostic?.({ details, type });
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
    if (window[stateKey]?.version === 2) {
      window[stateKey].report("reinstall");
      return;
    }
    const binding = window[bindingName];
    let sequence = 0;
    const report = (event) => {
      try {
        binding(JSON.stringify({
          event,
          hasFocus: document.hasFocus(),
          hidden: document.hidden,
          monotonicMs: performance.now(),
          sequence: sequence++,
          visibilityState: document.visibilityState,
          wasDiscarded: Boolean(document.wasDiscarded)
        }));
      } catch {}
    };
    window[stateKey] = { report, version: 2 };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
