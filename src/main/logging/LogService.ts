import { EventEmitter } from "node:events";

import type {
  LogCaptureRecord,
  LogEntry,
  LogErrorDetails,
  LogLevel,
  LogPageRecord,
  LogQuery,
  LogSource,
  LogStorageStatusRecord
} from "../../shared/generated";
import type { AppCoreClient } from "../core/nativeCore";

const MAX_CAPTURE_DEPTH = 8;
const MAX_CAPTURE_KEYS = 80;

type LogCoreClient = Pick<AppCoreClient, "invoke" | "subscribe">;
interface LogInitializationContext {
  appVersion: string;
  arch: string;
  platform: string;
}

/**
 * Thin capture adapter. Rust owns level filtering, session/sequence identity,
 * redaction, bounded buffering, persistence batching, retention and queries.
 */
export class LogService extends EventEmitter {
  private core?: LogCoreClient;
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopped = false;
  private unsubscribe?: () => void;

  async initialize(
    core: LogCoreClient,
    context: LogInitializationContext = {
      appVersion: "unknown",
      arch: process.arch,
      platform: process.platform
    }
  ): Promise<void> {
    if (this.stopped) throw new Error("Log service is shut down.");
    this.core = core;
    this.unsubscribe = core.subscribe((events) => {
      for (const event of events) {
        if (event.type !== "logEntriesCaptured") continue;
        event.entries.forEach((entry) => this.emit("entry", entry));
      }
    });
    this.info("main", "app_session_started", "Application logging started.", {
      appVersion: context.appVersion,
      platform: context.platform,
      arch: context.arch
    });
    await this.flush();
  }

  debug(source: LogSource, event: string, message: string, context?: Record<string, unknown>): void {
    this.log("debug", source, event, message, context);
  }

  info(source: LogSource, event: string, message: string, context?: Record<string, unknown>): void {
    this.log("info", source, event, message, context);
  }

  warn(
    source: LogSource,
    event: string,
    message: string,
    context?: Record<string, unknown>,
    error?: unknown
  ): void {
    this.log("warn", source, event, message, context, error);
  }

  error(
    source: LogSource,
    event: string,
    message: string,
    error?: unknown,
    context?: Record<string, unknown>
  ): void {
    this.log("error", source, event, message, context, error);
  }

  log(
    level: LogLevel,
    source: LogSource,
    event: string,
    message: string,
    context?: Record<string, unknown>,
    error?: unknown
  ): void {
    if (this.stopped) return;
    const core = this.core;
    if (!core) {
      process.stderr.write(`Rion Studio early log (${level}/${event}) occurred before core initialization.\n`);
      return;
    }
    const capture: LogCaptureRecord = {
      level,
      source,
      event,
      message,
      ...(context === undefined
        ? {}
        : { contextRawJson: JSON.stringify(toJsonCaptureValue(context)) }),
      ...(error === undefined ? {} : { error: captureError(error) })
    };
    this.track(core.invoke({ type: "logsCapture", entries: [capture] }));
  }

  async setLevel(level: LogLevel): Promise<void> {
    await this.requireCore().invoke({ type: "logsSetLevel", level });
    this.info("main", "log_level_changed", `Log level changed to ${level}.`);
  }

  async flush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.flush();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.core = undefined;
    this.removeAllListeners();
  }

  async getStatus(): Promise<LogStorageStatusRecord> {
    await this.flush();
    return this.requireCore().invoke({ type: "logsStatus" });
  }

  async query(query: LogQuery = {}): Promise<LogPageRecord> {
    await this.flush();
    return this.requireCore().invoke({ type: "logsQuery", query });
  }

  async clear(): Promise<void> {
    await this.flush();
    await this.requireCore().invoke({ type: "logsClear" });
    this.info("main", "logs_cleared", "Application logs were cleared by the user.");
    await this.flush();
  }

  private track(operation: Promise<unknown>): void {
    this.inFlight.add(operation);
    void operation
      .catch((error) => {
        process.stderr.write(`Rion Studio log capture failed: ${String(error)}\n`);
      })
      .finally(() => this.inFlight.delete(operation));
  }

  private requireCore(): LogCoreClient {
    if (!this.core) throw new Error("Rust log capture is not initialized.");
    return this.core;
  }
}

function toJsonCaptureValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (value instanceof Error) return captureError(value);
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_CAPTURE_DEPTH) return "<MAX_DEPTH>";
  if (seen.has(value)) return "<CIRCULAR>";
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_CAPTURE_KEYS)
      .map((item) => toJsonCaptureValue(item, depth + 1, seen));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_CAPTURE_KEYS)
      .map(([key, item]) => [key, toJsonCaptureValue(item, depth + 1, seen)])
  );
}

function captureError(error: unknown, depth = 0): LogErrorDetails {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  return {
    name: error.name || "Error",
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.cause !== undefined && depth < MAX_CAPTURE_DEPTH
      ? { cause: captureError(error.cause, depth + 1) }
      : {})
  };
}

export type { LogEntry };
