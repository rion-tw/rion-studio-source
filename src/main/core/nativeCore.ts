import { createRequire } from "node:module";
import { join } from "node:path";

import { app } from "electron";

import type {
  BootstrapPlanRecord,
  CoreCommand,
  CoreCommandResult,
  CoreEffectDispatchReport,
  CoreEffectResult,
  CoreEvent,
  PerformanceTelemetryRecord,
  TelemetryMetric
} from "../../shared/generated";

export interface NativeAppCore {
  dispatchCoreEffectResults: (resultsJson: string) => Promise<string>;
  invoke: (commandJson: string) => Promise<string>;
  shutdown: () => Promise<void>;
  subscribeCoreEvents: (callback: (eventsJson: string) => void) => void;
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
  invoke<C extends CoreCommand>(command: C): Promise<CoreCommandResult<C>>;
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

  async invoke<C extends CoreCommand>(command: C): Promise<CoreCommandResult<C>> {
    try {
      return JSON.parse(
        await this.native.invoke(JSON.stringify(command))
      ) as CoreCommandResult<C>;
    } catch (error) {
      throw normalizeNativeCoreError(error);
    }
  }

  get performanceTelemetryEnabled(): boolean {
    return this.telemetryEnabled;
  }

  subscribe(listener: (events: CoreEvent[]) => void): () => void {
    this.eventListeners.add(listener);
    if (this.lastEvents.length > 0) listener(this.lastEvents);
    return () => this.eventListeners.delete(listener);
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

  getPerformanceMetrics(): Promise<PerformanceTelemetryRecord> {
    return this.invoke({ type: "telemetrySnapshot" });
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

  recordWorkspaceLaunchTelemetry(durationMs: number, eventLoopP95Ms: number): void {
    this.recordTelemetry("workspaceLaunch", durationMs);
    this.recordTelemetry("mainEventLoopDelay", eventLoopP95Ms);
  }

  recordRendererRafLatency(durationMs: number): void {
    this.recordTelemetry("rendererRaf", durationMs);
  }

  recordLayoutPass(count = 1): void {
    this.recordTelemetry("layoutPass", undefined, count);
  }

  recordRuntimePublish(count = 1): void {
    this.recordTelemetry("runtimePublish", undefined, count);
  }

  recordMenuRefresh(count = 1): void {
    this.recordTelemetry("menuRefresh", undefined, count);
  }

  async shutdown(): Promise<void> {
    try {
      await this.native.shutdown();
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
    void this.invoke({
      type: "telemetryRecord",
      sample: {
        metric,
        count,
        ...(durationMs === undefined ? {} : { durationMs })
      }
    }).catch(() => undefined);
  }
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
