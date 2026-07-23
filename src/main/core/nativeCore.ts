import { createRequire } from "node:module";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import { app } from "electron";

import type {
  BrowserActionRequest,
  BrowserActionResult,
  BrowserOperationLease,
  BrowserOperationRequest,
  BrowserRoleStatusRecord,
  BrowserRuntimeCommand,
  BrowserRuntimeResult,
  BrowserWorkspaceStatusRecord,
  BootstrapPlanRecord,
  CoreCommand,
  CoreCommandResult,
  CoreEffectDispatchReport,
  CoreEffectResult,
  CoreEvent,
  EmbeddedKeyTransitionRecord,
  ExternalBrowserActionDispatch,
  ExternalSessionCommand,
  ExternalSessionResult,
  PerformanceTelemetryRecord,
  ResourcePolicyDecision,
  ResourcePolicyInput,
  ResourceRuntimeCommand,
  ResourceRuntimeResult,
  TelemetryMetric,
  RolePathsRecord,
  LayoutRect,
  LayoutRoleInput,
  WorkspaceDividerDescriptor,
  WorkspaceDividerResizeInput,
  WorkspaceDividerResizeOutput,
  WorkspaceLayoutInput,
  WorkspaceLayoutOutput
} from "../../shared/generated";
import type { PixelBounds, WorkspaceBrowserZoomPercent } from "../../shared/types";
import type {
  CdpEventClientLike,
  CdpNotification
} from "../browser/ExternalChromeCdpBridge";

interface NativeExternalChromeCdpClient {
  close: () => void;
  send: (
    method: string,
    paramsJson?: string,
    timeoutMs?: number,
    sessionId?: string
  ) => Promise<string>;
  subscribeEvents: (callback: (eventJson: string) => void) => void;
}

export interface ExternalChromeProcessLike {
  readonly pid?: number;
  killed: boolean;
  exitCode: number | null;
  kill: () => boolean;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
}

export interface NativeAppCore {
  acquireBrowserOperation: (requestJson: string) => Promise<string>;
  browserStatuses: () => string;
  browserWorkspaceStatuses: () => string;
  alignExternalChromeWindow: (processId: number, target: PixelBounds) => Promise<PixelBounds>;
  cancelWait: (id: string) => void;
  dispatchBrowserResults: (resultsJson: string) => Promise<void>;
  dispatchCoreEffectResults: (resultsJson: string) => Promise<string>;
  dispatchExternalBrowserActions: (actionsJson: string) => Promise<string>;
  focusExternalChrome: (roleId: string) => Promise<void>;
  setExternalChromeWindowBounds: (roleId: string, boundsJson: string) => Promise<void>;
  captureExternalChromeDiagnostics: (roleId: string) => Promise<string>;
  evaluateExternalChrome: (roleId: string, source: string) => Promise<string>;
  connectExternalChromeCdp: (
    roleId: string,
    browserUserDataDir: string,
    launchUrl: string,
    timeoutMs?: number,
    cdnEnabled?: boolean
  ) => Promise<NativeExternalChromeCdpClient>;
  completeBrowserOperation: (id: string) => void;
  completeEmbeddedKeyTransition: (transitionId: string, succeeded: boolean) => void;
  clearEmbeddedKeys: (roleId: string) => void;
  findSystemChromeExecutable: () => string;
  invoke: (commandJson: string) => Promise<string>;
  invokeBrowserRuntime: (commandJson: string) => string;
  invokeResourceRuntime: (commandJson: string) => string;
  invokeExternalSession: (commandJson: string) => string;
  hasEmbeddedHeldKeys: (roleId: string) => boolean;
  prepareEmbeddedKeyTransition: (
    roleId: string,
    phase: string,
    code: string,
    modifierCodesJson: string,
    ownerId: string
  ) => string;
  prepareExternalChromeProfile: (path: string) => Promise<void>;
  reassertEmbeddedKeys: (roleId: string) => string;
  matchCdnUrl: (url: string) => string | null;
  createWorkspaceDividers: (inputJson: string) => string;
  normalizeWorkspaceRects: (inputJson: string) => string;
  resolveAdaptiveWorkspaceZoom: (viewportWidth: number, currentPercent?: number) => number;
  resolveResourcePolicy: (inputJson: string) => string;
  resolveRolePaths: (roleId: string) => string;
  resizeWorkspaceDivider: (inputJson: string) => string;
  resolveWorkspaceLayout: (inputJson: string) => string;
  shutdown: () => Promise<void>;
  scheduleWait: (id: string, durationMs: number) => Promise<void>;
  subscribeCoreEvents: (callback: (eventsJson: string) => void) => void;
  updateSystemPressureSignals: (
    speedLimit: number | undefined,
    thermalState: string | undefined
  ) => void;
  unregisterExternalChromeAutomation: (roleId: string) => void;
}

interface NativeCoreAddon {
  coreVersion: () => string;
  readBootstrapPlan: (
    userDataDir: string,
    platform: string,
    currentEnableFeatures: string,
    currentDisableFeatures: string
  ) => string;
  createAppCore: (options: {
    appVersion: string;
    performanceTelemetryPath?: string;
    platform: string;
    userDataDir: string;
  }) => Promise<NativeAppCore>;
}

export function readBootstrapPlan(
  options: AppCoreClientOptions,
  currentEnableFeatures: string,
  currentDisableFeatures: string
): BootstrapPlanRecord {
  const addon = loadNativeCoreAddon(options);
  return JSON.parse(addon.readBootstrapPlan(
    options.userDataDir,
    options.platform ?? process.platform,
    currentEnableFeatures,
    currentDisableFeatures
  )) as BootstrapPlanRecord;
}

export interface AppCoreClientOptions {
  addonPath?: string;
  appVersion: string;
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  performanceTelemetryPath?: string;
  resourcesPath?: string;
  userDataDir: string;
}

export interface EmbeddedKeyRuntimeClient {
  clearEmbeddedKeys(roleId: string): void;
  completeEmbeddedKeyTransition(transitionId: string, succeeded: boolean): void;
  hasEmbeddedHeldKeys(roleId: string): boolean;
  prepareEmbeddedKeyTransition(
    roleId: string,
    phase: "hold" | "release" | "tap",
    code: string,
    modifierCodes: string[],
    ownerId: string
  ): EmbeddedKeyTransitionRecord;
  reassertEmbeddedKeys(roleId: string): EmbeddedKeyTransitionRecord;
}

export class AppCoreClient {
  private readonly eventListeners = new Set<(events: CoreEvent[]) => void>();
  private lastEvents: CoreEvent[] = [];

  private constructor(
    readonly version: string,
    private readonly native: NativeAppCore,
    private readonly telemetryEnabled: boolean
  ) {
    this.native.subscribeCoreEvents((eventsJson) => {
      try {
        const events = JSON.parse(eventsJson) as CoreEvent[];
        this.recordTelemetry("coreEventBatch");
        this.lastEvents = events;
        this.eventListeners.forEach((listener) => listener(events));
      } catch (error) {
        process.stderr.write(`Rion Studio core event decoding failed: ${String(error)}\n`);
      }
    });
  }

  static async create(options: AppCoreClientOptions): Promise<AppCoreClient> {
    const addon = loadNativeCoreAddon(options);
    try {
      const native = await addon.createAppCore({
        appVersion: options.appVersion,
        performanceTelemetryPath: options.performanceTelemetryPath,
        platform: options.platform ?? process.platform,
        userDataDir: options.userDataDir
      });
      return new AppCoreClient(
        addon.coreVersion(),
        native,
        options.performanceTelemetryPath !== undefined
      );
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  async invoke<T>(command: CoreCommand): Promise<T> {
    try {
      return JSON.parse(await this.native.invoke(JSON.stringify(command))) as T;
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  async invokeTyped<C extends CoreCommand>(command: C): Promise<CoreCommandResult<C>> {
    return this.invoke<CoreCommandResult<C>>(command);
  }

  invokeBrowserRuntime(command: BrowserRuntimeCommand): BrowserRuntimeResult {
    try {
      return this.measureSync(() =>
        JSON.parse(this.native.invokeBrowserRuntime(JSON.stringify(command))) as BrowserRuntimeResult
      );
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  invokeResourceRuntime(command: ResourceRuntimeCommand): ResourceRuntimeResult {
    try {
      return this.measureSync(() =>
        JSON.parse(this.native.invokeResourceRuntime(JSON.stringify(command))) as ResourceRuntimeResult
      );
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  invokeExternalSession(command: ExternalSessionCommand): ExternalSessionResult {
    try {
      return this.measureSync(() =>
        JSON.parse(this.native.invokeExternalSession(JSON.stringify(command))) as ExternalSessionResult
      );
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  listBrowserStatuses(): BrowserRoleStatusRecord[] {
    try {
      return this.measureSync(() =>
        JSON.parse(this.native.browserStatuses()) as BrowserRoleStatusRecord[]
      );
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  listBrowserWorkspaceStatuses(): BrowserWorkspaceStatusRecord[] {
    try {
      return this.measureSync(() =>
        JSON.parse(this.native.browserWorkspaceStatuses()) as BrowserWorkspaceStatusRecord[]
      );
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  async acquireBrowserOperation(
    request: BrowserOperationRequest
  ): Promise<BrowserOperationLease> {
    try {
      return JSON.parse(
        await this.native.acquireBrowserOperation(JSON.stringify(request))
      ) as BrowserOperationLease;
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  completeBrowserOperation(id: string): void {
    try {
      this.measureSync(() => this.native.completeBrowserOperation(id));
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  prepareEmbeddedKeyTransition(
    roleId: string,
    phase: "hold" | "release" | "tap",
    code: string,
    modifierCodes: string[],
    ownerId: string
  ): EmbeddedKeyTransitionRecord {
    try {
      return this.measureSync(() => JSON.parse(
        this.native.prepareEmbeddedKeyTransition(
          roleId,
          phase,
          code,
          JSON.stringify(modifierCodes),
          ownerId
        )
      ) as EmbeddedKeyTransitionRecord);
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  completeEmbeddedKeyTransition(transitionId: string, succeeded: boolean): void {
    try {
      this.measureSync(() => this.native.completeEmbeddedKeyTransition(transitionId, succeeded));
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  reassertEmbeddedKeys(roleId: string): EmbeddedKeyTransitionRecord {
    try {
      return this.measureSync(() =>
        JSON.parse(this.native.reassertEmbeddedKeys(roleId)) as EmbeddedKeyTransitionRecord
      );
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  hasEmbeddedHeldKeys(roleId: string): boolean {
    try {
      return this.measureSync(() => this.native.hasEmbeddedHeldKeys(roleId));
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  clearEmbeddedKeys(roleId: string): void {
    try {
      this.measureSync(() => this.native.clearEmbeddedKeys(roleId));
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  subscribe(listener: (events: CoreEvent[]) => void): () => void {
    this.eventListeners.add(listener);
    if (this.lastEvents.length > 0) listener(this.lastEvents);
    return () => this.eventListeners.delete(listener);
  }

  async dispatchBrowserResults(results: BrowserActionResult[]): Promise<void> {
    try {
      await this.native.dispatchBrowserResults(JSON.stringify(results));
      this.recordTelemetry("browserResult", undefined, results.length);
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  async dispatchCoreEffectResults(
    results: CoreEffectResult[]
  ): Promise<CoreEffectDispatchReport> {
    try {
      return JSON.parse(
        await this.native.dispatchCoreEffectResults(JSON.stringify(results))
      ) as CoreEffectDispatchReport;
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  findSystemChromeExecutable(): string {
    return this.measureSync(() => this.native.findSystemChromeExecutable());
  }

  launchExternalChrome(
    roleId: string,
    executablePath: string,
    arguments_: string[]
  ): ExternalChromeProcessLike {
    return new RustExternalChromeProcess(
      roleId,
      async () => {
        const result = await this.invoke<{ pid: number }>({
          type: "externalProcessLaunch",
          roleId,
          executablePath,
          arguments: arguments_
        });
        this.recordTelemetry("processLaunch");
        return result.pid;
      },
      async () => {
        await this.invoke({ type: "externalProcessTerminate", roleId });
      },
      (listener) => this.subscribe((events) => {
        events.forEach((event) => {
          if (event.type === "externalProcessExited" && event.roleId === roleId) {
            listener(event.exitCode ?? null);
          }
        });
      })
    );
  }

  async prepareExternalChromeProfile(path: string): Promise<void> {
    try {
      await this.native.prepareExternalChromeProfile(path);
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  async connectExternalChromeCdp(
    roleId: string,
    browserUserDataDir: string,
    launchUrl: string,
    timeoutMs?: number,
    cdnEnabled?: boolean
  ): Promise<CdpEventClientLike> {
    try {
      const native = await this.native.connectExternalChromeCdp(
        roleId,
        browserUserDataDir,
        launchUrl,
        timeoutMs,
        cdnEnabled
      );
      return new RustExternalChromeCdpClient(native, (durationMs) => {
        this.recordTelemetry("cdp", durationMs);
      });
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  async dispatchExternalBrowserActions(
    actions: BrowserActionRequest[]
  ): Promise<ExternalBrowserActionDispatch> {
    try {
      return JSON.parse(
        await this.native.dispatchExternalBrowserActions(JSON.stringify(actions))
      ) as ExternalBrowserActionDispatch;
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  async focusExternalChrome(roleId: string): Promise<void> {
    try {
      await this.native.focusExternalChrome(roleId);
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  async setExternalChromeWindowBounds(roleId: string, bounds: PixelBounds): Promise<void> {
    try {
      await this.native.setExternalChromeWindowBounds(roleId, JSON.stringify(bounds));
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  async captureExternalChromeDiagnostics<T>(roleId: string): Promise<T> {
    try {
      return JSON.parse(await this.native.captureExternalChromeDiagnostics(roleId)) as T;
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  async evaluateExternalChrome<T>(roleId: string, source: string): Promise<T> {
    try {
      return JSON.parse(await this.native.evaluateExternalChrome(roleId, source)) as T;
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  unregisterExternalChromeAutomation(roleId: string): void {
    try {
      this.measureSync(() => this.native.unregisterExternalChromeAutomation(roleId));
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  alignExternalChromeWindow(processId: number, target: PixelBounds): Promise<PixelBounds> {
    return this.native.alignExternalChromeWindow(processId, target)
      .catch((error) => {
        throw normalizeNativeCoreError(error);
      });
  }

  matchCdnUrl(url: string): string | undefined {
    return this.measureSync(() => this.native.matchCdnUrl(url) ?? undefined);
  }

  resolveResourcePolicy(input: ResourcePolicyInput): ResourcePolicyDecision {
    return this.measureSync(() =>
      JSON.parse(this.native.resolveResourcePolicy(JSON.stringify(input))) as ResourcePolicyDecision
    );
  }

  resolveRolePaths(roleId: string): RolePathsRecord {
    try {
      return this.measureSync(() =>
        JSON.parse(this.native.resolveRolePaths(roleId)) as RolePathsRecord
      );
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  resolveWorkspaceLayout(input: WorkspaceLayoutInput): WorkspaceLayoutOutput {
    return this.measureSync(() =>
      JSON.parse(this.native.resolveWorkspaceLayout(JSON.stringify(input))) as WorkspaceLayoutOutput
    );
  }

  resolveAdaptiveWorkspaceZoom(
    viewportWidth: number,
    currentPercent?: WorkspaceBrowserZoomPercent
  ): WorkspaceBrowserZoomPercent {
    return this.measureSync(() =>
      this.native.resolveAdaptiveWorkspaceZoom(viewportWidth, currentPercent)
    ) as WorkspaceBrowserZoomPercent;
  }

  normalizeWorkspaceRects(rects: LayoutRect[]): LayoutRect[] {
    return this.measureSync(() =>
      JSON.parse(this.native.normalizeWorkspaceRects(JSON.stringify(rects))) as LayoutRect[]
    );
  }

  createWorkspaceDividers(roles: LayoutRoleInput[]): WorkspaceDividerDescriptor[] {
    return this.measureSync(() =>
      JSON.parse(
        this.native.createWorkspaceDividers(JSON.stringify(roles))
      ) as WorkspaceDividerDescriptor[]
    );
  }

  resizeWorkspaceDivider(input: WorkspaceDividerResizeInput): WorkspaceDividerResizeOutput {
    return this.measureSync(() =>
      JSON.parse(
        this.native.resizeWorkspaceDivider(JSON.stringify(input))
      ) as WorkspaceDividerResizeOutput
    );
  }

  scheduleWait(id: string, durationMs: number): Promise<void> {
    const wait = this.native.scheduleWait(id, durationMs).catch((error) => {
      throw normalizeNativeCoreError(error);
    });
    this.recordTelemetry("scheduledWait");
    return wait;
  }

  cancelWait(id: string): void {
    this.measureSync(() => this.native.cancelWait(id));
  }

  updateSystemPressureSignals(input: {
    speedLimit?: number;
    thermalState?: string;
  }): void {
    this.measureSync(() =>
      this.native.updateSystemPressureSignals(input.speedLimit, input.thermalState)
    );
  }

  getPerformanceMetrics(): Promise<PerformanceTelemetryRecord> {
    return this.invokeTyped({ type: "telemetrySnapshot" });
  }

  recordIpcCommandLatency(durationMs: number): void {
    this.recordTelemetry("ipcCommand", durationMs);
  }

  recordMacroScheduleToDispatchLatency(durationMs: number): void {
    this.recordTelemetry("macroScheduleToDispatch", durationMs);
  }

  recordTabActivationLatency(durationMs: number): void {
    this.recordTelemetry("tabActivation", durationMs);
  }

  async shutdown(): Promise<void> {
    try {
      await this.native.shutdown();
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  private measureSync<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  private recordTelemetry(
    metric: TelemetryMetric,
    durationMs?: number,
    count = 1
  ): void {
    if (!this.telemetryEnabled) return;
    void this.invokeTyped({
      type: "telemetryRecord",
      sample: {
        metric,
        count,
        ...(durationMs === undefined ? {} : { durationMs })
      }
    }).catch(() => undefined);
  }
}

class RustExternalChromeProcess extends EventEmitter implements ExternalChromeProcessLike {
  pid?: number;
  killed = false;
  exitCode: number | null = null;
  private unsubscribe?: () => void;

  constructor(
    roleId: string,
    launch: () => Promise<number>,
    private readonly terminate: () => Promise<void>,
    subscribeExit: (listener: (exitCode: number | null) => void) => () => void
  ) {
    super();
    this.unsubscribe = subscribeExit((exitCode) => {
      this.exitCode = exitCode;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.emit("close", exitCode);
    });
    queueMicrotask(() => {
      void launch()
        .then((pid) => {
          this.pid = pid;
          this.emit("spawn");
          if (this.killed) void this.terminate();
        })
        .catch((error) => {
          this.unsubscribe?.();
          this.unsubscribe = undefined;
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        });
    });
    void roleId;
  }

  kill(): boolean {
    if (this.killed || this.exitCode !== null) return false;
    this.killed = true;
    if (this.pid !== undefined) void this.terminate();
    return true;
  }
}

class RustExternalChromeCdpClient implements CdpEventClientLike {
  private readonly disconnectListeners = new Set<() => void>();
  private readonly notificationListeners = new Set<(notification: CdpNotification) => void>();
  private disconnected = false;

  constructor(
    private readonly native: NativeExternalChromeCdpClient,
    private readonly recordRoundTrip: (durationMs: number) => void
  ) {
    native.subscribeEvents((eventJson) => {
      let event: {
        type?: unknown;
        method?: unknown;
        params?: unknown;
        sessionId?: unknown;
      };
      try {
        event = JSON.parse(eventJson) as typeof event;
      } catch {
        return;
      }
      if (event.type === "notification" && typeof event.method === "string") {
        const notification: CdpNotification = {
          method: event.method,
          ...(isRecord(event.params) ? { params: event.params } : {}),
          ...(typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {})
        };
        this.notificationListeners.forEach((listener) => listener(notification));
      } else if (event.type === "disconnected") {
        this.emitDisconnect();
      }
    });
  }

  async send<T>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    sessionId?: string
  ): Promise<T> {
    if (this.disconnected) throw new Error("Chrome DevTools WebSocket closed.");
    const startedAt = performance.now();
    try {
      return JSON.parse(
        await this.native.send(
          method,
          params === undefined ? undefined : JSON.stringify(params),
          timeoutMs,
          sessionId
        )
      ) as T;
    } catch (error) {
      throw normalizeNativeCoreError(error);
    } finally {
      this.recordRoundTrip(performance.now() - startedAt);
    }
  }

  close(): void {
    this.native.close();
    this.emitDisconnect();
  }

  onDisconnect(listener: () => void): () => void {
    if (this.disconnected) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  onNotification(listener: (notification: CdpNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  private emitDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.disconnectListeners.forEach((listener) => listener());
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function resolveNativeCoreAddonPath(options: AppCoreClientOptions): string {
  if (options.addonPath) return options.addonPath;
  const platform = options.platform ?? process.platform;
  const isPackaged = options.isPackaged ?? app.isPackaged;
  return isPackaged
    ? join(options.resourcesPath ?? process.resourcesPath, "native", "rion-core.node")
    : join(app.getAppPath(), "build", "native", `${platform}-${process.arch}`, "rion-core.node");
}

function loadNativeCoreAddon(options: AppCoreClientOptions): NativeCoreAddon {
  const addonPath = resolveNativeCoreAddonPath(options);
  try {
    const require = createRequire(import.meta.url);
    const addon = require(addonPath) as Partial<NativeCoreAddon>;
    if (
      typeof addon.coreVersion !== "function" ||
      typeof addon.createAppCore !== "function" ||
      typeof addon.readBootstrapPlan !== "function"
    ) {
      throw new Error("The addon does not expose the required Node-API surface.");
    }
    return addon as NativeCoreAddon;
  } catch (error) {
    throw new Error(
      `Rion Studio could not load its Rust application core at ${addonPath}. ` +
      "Reinstall the application or rebuild the native core.",
      { cause: error }
    );
  }
}

function normalizeNativeCoreError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  try {
    const payload = JSON.parse(error.message) as { code?: unknown; message?: unknown };
    if (typeof payload.code === "string" && typeof payload.message === "string") {
      const normalized = new Error(payload.message) as Error & { code: string };
      normalized.code = payload.code;
      return normalized;
    }
  } catch {
    // Preserve non-core errors such as addon loading or JavaScript failures.
  }
  return error;
}
