import { createRequire } from "node:module";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import { app } from "electron";

import type {
  BrowserActionResult,
  CdnRule,
  CoreCommand,
  CoreEvent,
  ResourcePolicyDecision,
  ResourcePolicyInput,
  WorkspaceLayoutInput,
  WorkspaceLayoutOutput
} from "../../shared/generated";
import type { PixelBounds } from "../../shared/types";
import type {
  CdpEventClientLike,
  CdpNotification
} from "../system-browser/SystemChromeLauncher";

interface NativeExternalChromeProcess {
  pid: () => number;
  subscribeExit: (callback: (eventJson: string) => void) => void;
  terminate: () => void;
}

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
  alignExternalChromeWindow: (processId: number, target: PixelBounds) => Promise<PixelBounds>;
  cancelWait: (id: string) => void;
  dispatchBrowserResults: (resultsJson: string) => Promise<void>;
  connectExternalChromeCdp: (
    browserUserDataDir: string,
    launchUrl: string,
    timeoutMs?: number
  ) => Promise<NativeExternalChromeCdpClient>;
  findSystemChromeExecutable: () => string;
  invoke: (commandJson: string) => Promise<string>;
  launchExternalChrome: (
    executablePath: string,
    arguments_: string[]
  ) => NativeExternalChromeProcess;
  prepareExternalChromeProfile: (path: string) => Promise<void>;
  replaceCdnRules: (rulesJson: string) => string[];
  resolveResourcePolicy: (inputJson: string) => string;
  resolveWorkspaceLayout: (inputJson: string) => string;
  rewriteCdnUrl: (url: string) => string | null;
  shutdown: () => Promise<void>;
  scheduleWait: (id: string, durationMs: number) => Promise<void>;
  subscribeCoreEvents: (callback: (eventsJson: string) => void) => void;
  updateSystemPressureSignals: (
    speedLimit: number | undefined,
    thermalState: string | undefined
  ) => void;
}

interface NativeCoreAddon {
  coreVersion: () => string;
  createAppCore: (options: {
    appVersion: string;
    platform: string;
    userDataDir: string;
  }) => Promise<NativeAppCore>;
}

export interface AppCoreClientOptions {
  addonPath?: string;
  appVersion: string;
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  resourcesPath?: string;
  userDataDir: string;
}

export interface RuntimePerformanceMetrics {
  browserResultCount: number;
  cdp: LatencySummary & { messageCount: number };
  coreEventBatchCount: number;
  ipcCommand: LatencySummary;
  macroScheduleToDispatch: LatencySummary;
  napi: LatencySummary & { callCount: number };
  processLaunchCount: number;
  scheduledWaitCount: number;
  startedAt: string;
  tabActivation: LatencySummary;
}

interface LatencySummary {
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  sampleCount: number;
}

export class AppCoreClient {
  private readonly eventListeners = new Set<(events: CoreEvent[]) => void>();
  private lastEvents: CoreEvent[] = [];
  private readonly metrics = new PerformanceMetrics();

  private constructor(
    readonly version: string,
    private readonly native: NativeAppCore
  ) {
    const startedAt = performance.now();
    this.native.subscribeCoreEvents((eventsJson) => {
      try {
        const events = JSON.parse(eventsJson) as CoreEvent[];
        this.metrics.coreEventBatchCount += 1;
        this.lastEvents = events;
        this.eventListeners.forEach((listener) => listener(events));
      } catch (error) {
        process.stderr.write(`Rion Studio core event decoding failed: ${String(error)}\n`);
      }
    });
    this.metrics.recordNapi(performance.now() - startedAt);
  }

  static async create(options: AppCoreClientOptions): Promise<AppCoreClient> {
    const addon = loadNativeCoreAddon(options);
    try {
      const native = await addon.createAppCore({
        appVersion: options.appVersion,
        platform: options.platform ?? process.platform,
        userDataDir: options.userDataDir
      });
      return new AppCoreClient(addon.coreVersion(), native);
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  async invoke<T>(command: CoreCommand): Promise<T> {
    const startedAt = performance.now();
    try {
      return JSON.parse(await this.native.invoke(JSON.stringify(command))) as T;
    } catch (error) {
      throw normalizeNativeCoreError(error);
    } finally {
      this.metrics.recordNapi(performance.now() - startedAt);
    }
  }

  subscribe(listener: (events: CoreEvent[]) => void): () => void {
    this.eventListeners.add(listener);
    if (this.lastEvents.length > 0) listener(this.lastEvents);
    return () => this.eventListeners.delete(listener);
  }

  async dispatchBrowserResults(results: BrowserActionResult[]): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.native.dispatchBrowserResults(JSON.stringify(results));
      this.metrics.browserResultCount += results.length;
    } catch (error) {
      throw normalizeNativeCoreError(error);
    } finally {
      this.metrics.recordNapi(performance.now() - startedAt);
    }
  }

  findSystemChromeExecutable(): string {
    return this.measureSync(() => this.native.findSystemChromeExecutable());
  }

  launchExternalChrome(executablePath: string, arguments_: string[]): ExternalChromeProcessLike {
    return this.measureSync(() => {
      const process = new RustExternalChromeProcess(
        this.native.launchExternalChrome(executablePath, arguments_)
      );
      this.metrics.processLaunchCount += 1;
      return process;
    });
  }

  async prepareExternalChromeProfile(path: string): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.native.prepareExternalChromeProfile(path);
    } catch (error) {
      throw normalizeNativeCoreError(error);
    } finally {
      this.metrics.recordNapi(performance.now() - startedAt);
    }
  }

  async connectExternalChromeCdp(
    browserUserDataDir: string,
    launchUrl: string,
    timeoutMs?: number
  ): Promise<CdpEventClientLike> {
    const startedAt = performance.now();
    try {
      const native = await this.native.connectExternalChromeCdp(
        browserUserDataDir,
        launchUrl,
        timeoutMs
      );
      return new RustExternalChromeCdpClient(native, (durationMs) => {
        this.metrics.recordCdp(durationMs);
      });
    } catch (error) {
      throw normalizeNativeCoreError(error);
    } finally {
      this.metrics.recordNapi(performance.now() - startedAt);
    }
  }

  alignExternalChromeWindow(processId: number, target: PixelBounds): Promise<PixelBounds> {
    const startedAt = performance.now();
    return this.native.alignExternalChromeWindow(processId, target)
      .catch((error) => {
        throw normalizeNativeCoreError(error);
      })
      .finally(() => {
        this.metrics.recordNapi(performance.now() - startedAt);
      });
  }

  replaceCdnRules(rules: CdnRule[]): string[] {
    return this.measureSync(() => this.native.replaceCdnRules(JSON.stringify(rules)));
  }

  rewriteCdnUrl(url: string): string | undefined {
    return this.measureSync(() => this.native.rewriteCdnUrl(url) ?? undefined);
  }

  resolveResourcePolicy(input: ResourcePolicyInput): ResourcePolicyDecision {
    return this.measureSync(() =>
      JSON.parse(this.native.resolveResourcePolicy(JSON.stringify(input))) as ResourcePolicyDecision
    );
  }

  resolveWorkspaceLayout(input: WorkspaceLayoutInput): WorkspaceLayoutOutput {
    return this.measureSync(() =>
      JSON.parse(this.native.resolveWorkspaceLayout(JSON.stringify(input))) as WorkspaceLayoutOutput
    );
  }

  scheduleWait(id: string, durationMs: number): Promise<void> {
    const startedAt = performance.now();
    const wait = this.native.scheduleWait(id, durationMs).catch((error) => {
      throw normalizeNativeCoreError(error);
    });
    this.metrics.scheduledWaitCount += 1;
    this.metrics.recordNapi(performance.now() - startedAt);
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

  getPerformanceMetrics(): RuntimePerformanceMetrics {
    return this.metrics.snapshot();
  }

  recordIpcCommandLatency(durationMs: number): void {
    this.metrics.recordIpcCommand(durationMs);
  }

  recordMacroScheduleToDispatchLatency(durationMs: number): void {
    this.metrics.recordMacroScheduleToDispatch(durationMs);
  }

  recordTabActivationLatency(durationMs: number): void {
    this.metrics.recordTabActivation(durationMs);
  }

  async shutdown(): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.native.shutdown();
    } catch (error) {
      throw normalizeNativeCoreError(error);
    } finally {
      this.metrics.recordNapi(performance.now() - startedAt);
    }
  }

  private measureSync<T>(operation: () => T): T {
    const startedAt = performance.now();
    try {
      return operation();
    } catch (error) {
      throw normalizeNativeCoreError(error);
    } finally {
      this.metrics.recordNapi(performance.now() - startedAt);
    }
  }
}

class RustExternalChromeProcess extends EventEmitter implements ExternalChromeProcessLike {
  readonly pid: number;
  killed = false;
  exitCode: number | null = null;

  constructor(private readonly native: NativeExternalChromeProcess) {
    super();
    this.pid = native.pid();
    native.subscribeExit((eventJson) => {
      try {
        const event = JSON.parse(eventJson) as { exitCode?: unknown; terminated?: unknown };
        this.killed = this.killed || event.terminated === true;
        this.exitCode = typeof event.exitCode === "number" ? event.exitCode : null;
        this.emit("close", this.exitCode);
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    });
    queueMicrotask(() => this.emit("spawn"));
  }

  kill(): boolean {
    if (this.killed || this.exitCode !== null) return false;
    this.killed = true;
    this.native.terminate();
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

class PerformanceMetrics {
  browserResultCount = 0;
  coreEventBatchCount = 0;
  processLaunchCount = 0;
  scheduledWaitCount = 0;
  private readonly cdpLatency = new LatencySampler();
  private readonly ipcCommandLatency = new LatencySampler();
  private readonly macroScheduleToDispatchLatency = new LatencySampler();
  private readonly napiLatency = new LatencySampler();
  private readonly tabActivationLatency = new LatencySampler();
  private readonly startedAt = new Date().toISOString();
  private cdpMessageCount = 0;
  private napiCallCount = 0;

  recordCdp(durationMs: number): void {
    this.cdpMessageCount += 1;
    this.cdpLatency.record(durationMs);
  }

  recordNapi(durationMs: number): void {
    this.napiCallCount += 1;
    this.napiLatency.record(durationMs);
  }

  recordIpcCommand(durationMs: number): void {
    this.ipcCommandLatency.record(durationMs);
  }

  recordMacroScheduleToDispatch(durationMs: number): void {
    this.macroScheduleToDispatchLatency.record(durationMs);
  }

  recordTabActivation(durationMs: number): void {
    this.tabActivationLatency.record(durationMs);
  }

  snapshot(): RuntimePerformanceMetrics {
    return {
      browserResultCount: this.browserResultCount,
      cdp: { messageCount: this.cdpMessageCount, ...this.cdpLatency.summary() },
      coreEventBatchCount: this.coreEventBatchCount,
      ipcCommand: this.ipcCommandLatency.summary(),
      macroScheduleToDispatch: this.macroScheduleToDispatchLatency.summary(),
      napi: { callCount: this.napiCallCount, ...this.napiLatency.summary() },
      processLaunchCount: this.processLaunchCount,
      scheduledWaitCount: this.scheduledWaitCount,
      startedAt: this.startedAt,
      tabActivation: this.tabActivationLatency.summary()
    };
  }
}

class LatencySampler {
  private readonly samples = new Float64Array(1_024);
  private count = 0;

  record(value: number): void {
    this.samples[this.count % this.samples.length] = value;
    this.count += 1;
  }

  summary(): LatencySummary {
    const sampleCount = Math.min(this.count, this.samples.length);
    if (sampleCount === 0) return { maxMs: 0, p50Ms: 0, p95Ms: 0, sampleCount: 0 };
    const values = Array.from(this.samples.slice(0, sampleCount)).sort((left, right) => left - right);
    return {
      maxMs: values.at(-1) ?? 0,
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95),
      sampleCount
    };
  }
}

function percentile(values: number[], percentileValue: number): number {
  return values[Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1)] ?? 0;
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
    if (typeof addon.coreVersion !== "function" || typeof addon.createAppCore !== "function") {
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
