import type {
  ApplicationLifecycleStatusRecord,
  AppUpdateStatusRecord,
  CoreEvent,
  LogCaptureRecord,
  LogErrorDetails,
  LogLevel,
  LogSource
} from "../../shared/generated";
import type { CoreAddonClient } from "../core/coreAddonClient";
import { normalizeRionBridgeError } from "../ipc/errors";

const STARTUP_BUFFER_CAPACITY = 256;
const CORE_CAPTURE_BATCH_CAPACITY = 256;

type LogContext = Readonly<Record<string, unknown>>;

export type ElectronOperationalLogCorePort = Pick<
  CoreAddonClient,
  "invoke" | "subscribeCoreEvents"
>;

export interface ElectronOperationalLoggerInput {
  readonly writeCaptureFailure?: (code: string) => void;
}

/**
 * Serializes Electron observations into the Rust-owned capture/persistence lane.
 * Its failures are intentionally stderr-only so logging can never recurse into
 * shell error presentation.
 */
export class ElectronOperationalLogger {
  readonly #input: ElectronOperationalLoggerInput;
  readonly #pendingCaptures: LogCaptureRecord[] = [];
  readonly #startupBuffer: LogCaptureRecord[] = [];
  readonly #macroStates = new Map<string, string>();
  #browserState: string | null = null;
  #core: ElectronOperationalLogCorePort | null = null;
  #draining = false;
  #disposed = false;
  #lane: Promise<void> = Promise.resolve();
  #lifecycleRevision = 0;
  #unsubscribeCoreEvents: (() => void) | null = null;
  #updateState: string | null = null;

  constructor(input: ElectronOperationalLoggerInput = {}) {
    this.#input = input;
  }

  bindCore(core: ElectronOperationalLogCorePort): void {
    if (this.#disposed || this.#core === core) return;
    if (this.#core) {
      this.#writeCaptureFailure("ELECTRON_OPERATIONAL_LOG_CORE_ALREADY_BOUND");
      return;
    }
    this.#core = core;
    const buffered = this.#startupBuffer.splice(0);
    if (buffered.length > 0) this.#enqueue(buffered);
    try {
      this.#unsubscribeCoreEvents = core.subscribeCoreEvents(this.#observeCoreEvent);
    } catch (error) {
      this.#writeCaptureFailure(stableErrorCode(
        error,
        "ELECTRON_OPERATIONAL_LOG_SUBSCRIPTION_FAILED"
      ));
    }
  }

  electronReady(): void {
    this.info("main", "electron_ready", "Electron is ready.");
  }

  rustCoreReady(): void {
    this.info("main", "rust_core_ready", "Rust Core is ready.");
  }

  shellError(error: { code: string; message: string }): void {
    this.error("main", "shell_error", "An Electron shell operation failed.",
      error, error.code);
  }

  fatalTerminationError(error: { code: string; message: string }): void {
    this.error("main", "fatal_termination_error", "Fatal termination encountered an error.",
      error, error.code);
  }

  fatalEventStreamFailure(rendererDrain: Promise<void>): Promise<void> {
    this.warn("main", "fatal_event_stream_failure", "The Core event stream failed terminally.");
    return Promise.all([this.flush(), rendererDrain]).then(() => undefined);
  }

  async applicationSessionReady(): Promise<void> {
    this.info("main", "application_session_ready", "Application session is ready.");
    this.debug("main", "debug_capture_active", "Debug capture is active for this session.", {
      startupBufferCapacity: STARTUP_BUFFER_CAPACITY
    });
    await this.flush();
  }

  trustedInputTerminal(context: LogContext): void {
    this.debug("macro", "trusted_input_terminal", "Trusted input reached a terminal outcome.",
      context);
  }

  managedShortcutTransition(context: LogContext): void {
    this.debug("macro", "managed_shortcut_transition", "Managed shortcut advanced.", context);
  }

  nativeWindowPlacement(context: LogContext): void {
    this.debug("browser", "native_window_placement", "Native window placement changed.", context);
  }

  async applicationQuitting(): Promise<void> {
    this.info("main", "app_quitting", "Application is quitting cleanly.");
    await this.flush();
  }

  async applicationStartupFailed(error: unknown, errorCode: string): Promise<void> {
    this.error("main", "application_startup_failed", "Application startup failed.",
      error, errorCode);
    await this.flush();
  }

  debug(source: LogSource, event: string, message: string, context?: LogContext): void {
    this.#record("debug", source, event, message, context);
  }

  info(source: LogSource, event: string, message: string, context?: LogContext): void {
    this.#record("info", source, event, message, context);
  }

  warn(source: LogSource, event: string, message: string, context?: LogContext): void {
    this.#record("warn", source, event, message, context);
  }

  error(
    source: LogSource,
    event: string,
    message: string,
    error: unknown,
    fallbackCode: string,
    context: LogContext = {}
  ): void {
    const errorCode = stableErrorCode(error, fallbackCode);
    this.#capture({
      level: "error",
      source,
      event,
      message,
      contextRawJson: encodeContext({ ...context, errorCode }),
      error: logErrorDetails(error, errorCode, stableErrorMessage(error))
    });
  }

  rendererError(event: string, message: string, stack?: string): void {
    this.#capture({
      level: "error",
      source: "renderer",
      event,
      message,
      ...(stack ? { error: { name: event, message, stack } } : {})
    });
  }

  async captureRendererError(event: string, message: string, stack?: string): Promise<void> {
    this.rendererError(event, message, stack);
    await this.flush();
  }

  diagnosticsExportSucceeded(logFileCount: number): void {
    this.info("main", "diagnostics_export_succeeded", "Diagnostics export completed.", {
      logFileCount
    });
  }

  diagnosticsExportFailed(error: unknown): void {
    this.error(
      "main",
      "diagnostics_export_failed",
      "Diagnostics export failed.",
      error,
      "ELECTRON_DIAGNOSTICS_EXPORT_FAILED"
    );
  }

  async runDiagnosticsExport<Result extends { logFileCount: number } | null>(
    work: () => Promise<Result>
  ): Promise<Result> {
    try {
      await this.flush();
      const result = await work();
      if (result) {
        this.diagnosticsExportSucceeded(result.logFileCount);
        await this.flush();
      }
      return result;
    } catch (error) {
      this.diagnosticsExportFailed(error);
      await this.flush();
      throw error;
    }
  }

  observeInvocationFailure(method: string | undefined, errorCode: string): void {
    this.warn("ipc", "ipc_invocation_failed", "An IPC invocation failed.", {
      ...(method ? { method } : {}),
      errorCode
    });
  }

  observeApplicationLifecycle(status: ApplicationLifecycleStatusRecord): void {
    if (status.revision <= this.#lifecycleRevision) return;
    this.#lifecycleRevision = status.revision;
    const context = {
      revision: status.revision,
      state: status.state,
      phase: status.reason
    };
    if (status.state === "degraded") {
      this.warn("main", "power_lifecycle_changed", "Application power lifecycle degraded.", context);
    } else {
      this.info("main", "power_lifecycle_changed", "Application power lifecycle changed.", context);
    }
  }

  observeUpdateStatus(status: AppUpdateStatusRecord): void {
    const context = {
      state: status.state,
      phase: status.installMode,
      ...(status.errorCode ? { errorCode: status.errorCode } : {})
    };
    const reduced = JSON.stringify(context);
    if (reduced === this.#updateState) return;
    this.#updateState = reduced;
    if (status.state === "error" || status.state === "install_failed") {
      this.warn("update", "updater_status_changed", "Updater status changed to failure.", context);
    } else {
      this.info("update", "updater_status_changed", "Updater status changed.", context);
    }
  }

  flush(): Promise<void> {
    return this.#lane;
  }

  async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#unsubscribeCoreEvents?.();
      this.#unsubscribeCoreEvents = null;
    }
    await this.#lane;
  }

  readonly #observeCoreEvent = (event: CoreEvent): void => {
    switch (event.type) {
      case "stateChanged":
        this.info("persistence", "core_state_changed", "Core state changed.", {
          revision: event.revision,
          count: event.changedCollections.length
        });
        return;
      case "browserStatuses":
        this.#observeBrowserStatuses(event.statuses);
        return;
      case "browserLaunchCompleted":
        this.#record(event.ok ? "info" : "warn", "browser", "browser_launch_completed",
          event.ok ? "Browser launch completed." : "Browser launch failed.", {
            operationId: event.operationId,
            sourceId: event.sourceId,
            phase: event.sourceType,
            tabId: event.tabId,
            state: event.ok ? "completed" : "failed",
            ...(event.errorCode ? { errorCode: event.errorCode } : {})
          });
        return;
      case "macroStatuses":
        this.#observeMacroStatuses(event.reliable, event.statuses);
        return;
      case "extensionsChanged":
        this.info("main", "extensions_changed", "Extension state changed.", {
          revision: event.snapshot.revision,
          installedCount: event.snapshot.installed.length,
          roleCount: event.snapshot.roles.length
        });
        return;
      case "graphicsSettingsChanged":
        this.info("main", "graphics_settings_changed", "Graphics settings changed.", {
          revision: event.snapshot.revision
        });
        return;
      case "roleSessionRecoveryChanged": {
        const record = event.record;
        this.info("persistence", "session_recovery_changed", "Session recovery changed.", {
          roleId: record.roleId,
          ...(record.attemptId ? { attemptId: record.attemptId } : {}),
          revision: record.revision,
          ...(record.journalRevision === null ? {} : {
            journalRevision: record.journalRevision
          }),
          phase: record.phase,
          sourceState: record.sourceIntegrity,
          targetState: record.targetEquality,
          persistenceState: record.persistence,
          loginState: record.login,
          blockerCount: record.blockers.length,
          candidateCount: record.candidates.length
        });
        return;
      }
      case "chromeProfileImportProgress":
        this.info("browser", "chrome_profile_import_progress", "Chrome import progressed.", {
          importId: event.progress.importId,
          ...(event.progress.profileId ? { profileId: event.progress.profileId } : {}),
          phase: event.progress.phase,
          completedCount: event.progress.completed,
          totalCount: event.progress.total
        });
        return;
      default:
        return;
    }
  };

  #observeBrowserStatuses(statuses: Extract<CoreEvent, {
    type: "browserStatuses";
  }>["statuses"]): void {
    const reduced = [...statuses]
      .map((status) => ({
        roleId: status.roleId,
        state: status.state,
        ...(status.automationState ? { automationState: status.automationState } : {}),
        ...(status.overlayState ? { overlayState: status.overlayState } : {}),
        ...(status.pageHealth ? { healthState: status.pageHealth } : {}),
        ...(status.issueReason ? { errorCode: status.issueReason } : {})
      }))
      .sort((left, right) => left.roleId.localeCompare(right.roleId));
    const key = JSON.stringify(reduced);
    if (key === this.#browserState) return;
    this.#browserState = key;
    this.info("browser", "browser_status_changed", "Browser status changed.", {
      count: reduced.length,
      states: reduced
    });
  }

  #observeMacroStatuses(
    reliable: boolean,
    statuses: Extract<CoreEvent, { type: "macroStatuses" }>["statuses"]
  ): void {
    const active = new Set<string>();
    for (const status of statuses) {
      const key = `${status.roleId}:${status.macroId}`;
      active.add(key);
      const reduced = JSON.stringify({ state: status.state, reliable });
      if (this.#macroStates.get(key) === reduced) continue;
      this.#macroStates.set(key, reduced);
      const level: LogLevel = status.state === "failed" || status.state === "cancelled"
        ? "warn"
        : "info";
      this.#record(level, "macro", "macro_lifecycle_changed", "Macro lifecycle changed.", {
        roleId: status.roleId,
        macroId: status.macroId,
        state: status.state,
        reliabilityState: reliable ? "reliable" : "unreliable"
      });
    }
    for (const key of [...this.#macroStates.keys()]) {
      if (active.has(key)) continue;
      this.#macroStates.delete(key);
      const separator = key.indexOf(":");
      this.info("macro", "macro_lifecycle_stopped", "Macro lifecycle stopped.", {
        roleId: key.slice(0, separator),
        macroId: key.slice(separator + 1),
        state: "stopped",
        reliabilityState: reliable ? "reliable" : "unreliable"
      });
    }
  }

  #record(
    level: LogLevel,
    source: LogSource,
    event: string,
    message: string,
    context?: LogContext
  ): void {
    this.#capture({
      level,
      source,
      event,
      message,
      ...(context ? { contextRawJson: encodeContext(context) } : {})
    });
  }

  #capture(record: LogCaptureRecord): void {
    if (this.#disposed) return;
    if (!this.#core) {
      if (this.#startupBuffer.length >= STARTUP_BUFFER_CAPACITY) {
        this.#startupBuffer.shift();
      }
      this.#startupBuffer.push(record);
      return;
    }
    this.#enqueue([record]);
  }

  #enqueue(entries: LogCaptureRecord[]): void {
    const core = this.#core;
    if (!core || entries.length === 0) return;
    this.#pendingCaptures.push(...entries);
    if (this.#draining) return;
    this.#draining = true;
    this.#lane = Promise.resolve().then(async () => {
      while (this.#pendingCaptures.length > 0) {
        const batch = this.#pendingCaptures.splice(0, CORE_CAPTURE_BATCH_CAPACITY);
        try {
          await core.invoke({ type: "logsCapture", entries: batch });
        } catch (error) {
          this.#writeCaptureFailure(stableErrorCode(
            error,
            "ELECTRON_OPERATIONAL_LOG_CAPTURE_FAILED"
          ));
        }
      }
    }).finally(() => {
      this.#draining = false;
    });
  }

  #writeCaptureFailure(code: string): void {
    try {
      (this.#input.writeCaptureFailure ?? writeCaptureFailure)(code);
    } catch {
      // stderr observation must not poison the ordered capture lane.
    }
  }
}

function logErrorDetails(
  error: unknown,
  fallbackName: string,
  fallbackMessage: string,
  depth = 0
): LogErrorDetails {
  if (!(error instanceof Error) || depth >= 5) {
    return { name: fallbackName, message: fallbackMessage };
  }
  const cause = error.cause === undefined
    ? undefined
    : logErrorDetails(error.cause, fallbackName, fallbackMessage, depth + 1);
  return {
    name: error.name || fallbackName,
    message: error.message || fallbackMessage,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(cause ? { cause } : {})
  };
}

function writeCaptureFailure(code: string): void {
  process.stderr.write(`Rion Studio log capture failed [${code}].\n`);
}

function encodeContext(context: LogContext): string | undefined {
  try {
    return JSON.stringify(context);
  } catch {
    return undefined;
  }
}

function stableErrorCode(error: unknown, fallbackCode: string): string {
  try {
    return normalizeRionBridgeError(error, fallbackCode).code;
  } catch {
    return fallbackCode;
  }
}

function stableErrorMessage(error: unknown): string {
  try {
    return normalizeRionBridgeError(error).message;
  } catch {
    return "Rion Studio could not complete the desktop request.";
  }
}
