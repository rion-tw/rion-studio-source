import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import {
  LOG_LEVELS,
  type LogEntry,
  type LogLevel,
  type LogPage,
  type LogQuery,
  type LogSource,
  type LogStorageStatus
} from "../../shared/types";
import { sanitizeError, sanitizeText, sanitizeValue } from "./logSanitizer";
import type { ZipFile } from "./zipWriter";

const LEVEL_VALUE: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const PRE_CORE_BUFFER_MAX_ENTRIES = 256;
export interface LogServiceOptions {
  userDataPath: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
  appVersion?: string;
  /** Retained only for source compatibility; production logging never writes JSONL. */
  deferFileWrites?: boolean;
}

export interface LogPersistence {
  append: (entries: LogEntry[]) => Promise<void>;
  clear: () => Promise<void>;
  exportJsonlTo: (path: string) => Promise<void>;
  getStatus: (currentLevel: LogLevel) => Promise<LogStorageStatus>;
  query: (query: LogQuery) => Promise<LogPage>;
}

export class LogService extends EventEmitter {
  readonly directory: string;
  readonly sessionId = randomUUID();
  private currentLevel: LogLevel = "info";
  private sequence = 0;
  private queue = Promise.resolve();
  private pendingEntries: LogEntry[] = [];
  private persistence?: LogPersistence;
  private stopped = false;
  private readonly now: () => Date;
  private readonly userDataPath: string;

  constructor(private readonly options: LogServiceOptions) {
    super();
    this.userDataPath = options.userDataPath;
    this.directory = join(options.userDataPath, "logs");
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    this.info("main", "app_session_started", "Application logging started.", {
      appVersion: this.options.appVersion,
      platform: this.options.platform ?? process.platform,
      arch: process.arch
    });
  }

  async usePersistence(persistence: LogPersistence): Promise<void> {
    if (this.stopped) {
      throw new Error("Log service is shut down.");
    }
    await this.queue;
    this.persistence = persistence;
    await this.flushPending();
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
    if (LEVEL_VALUE[level] < LEVEL_VALUE[this.currentLevel]) return;
    const entry: LogEntry = {
      id: `${this.sessionId}:${++this.sequence}`,
      timestamp: this.now().toISOString(),
      level,
      source,
      event: sanitizeText(event, this.userDataPath).slice(0, 120),
      message: sanitizeText(message, this.userDataPath),
      sessionId: this.sessionId
    };
    const sanitized = sanitizeValue(context, this.userDataPath);
    if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
      entry.context = sanitized as Record<string, unknown>;
    }
    if (error instanceof Error) entry.error = sanitizeError(error, this.userDataPath);
    else if (error !== undefined) {
      entry.error = { name: "Error", message: sanitizeText(String(error), this.userDataPath) };
    }
    this.emit("entry", entry);
    this.queue = this.queue.then(() => this.writeEntry(entry)).catch((writeError) => {
      process.stderr.write(`Rion Studio log database write failed: ${String(writeError)}\n`);
    });
  }

  setLevel(level: LogLevel): void {
    if (!LOG_LEVELS.includes(level)) throw new Error("Invalid log level.");
    this.currentLevel = level;
    this.info("main", "log_level_changed", `Log level changed to ${level}.`);
  }

  async flush(): Promise<void> {
    await this.queue;
    await this.flushPending();
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.queue;
    await this.flushPending();
    this.persistence = undefined;
    this.removeAllListeners();
  }

  async getStatus(): Promise<LogStorageStatus> {
    await this.flush();
    return this.requirePersistence().getStatus(this.currentLevel);
  }

  async query(query: LogQuery = {}): Promise<LogPage> {
    await this.flush();
    return this.requirePersistence().query(query);
  }

  async clear(): Promise<void> {
    await this.flush();
    await this.requirePersistence().clear();
    this.info("main", "logs_cleared", "Application logs were cleared by the user.");
  }

  async getFiles(exportPath: string): Promise<ZipFile[]> {
    await this.flush();
    await this.requirePersistence().exportJsonlTo(exportPath);
    return [{ name: "rion-studio-logs.jsonl", path: exportPath }];
  }

  private async writeEntry(entry: LogEntry): Promise<void> {
    if (this.persistence) {
      await this.persistence.append([entry]);
      return;
    }
    if (this.pendingEntries.length >= PRE_CORE_BUFFER_MAX_ENTRIES) {
      const discardIndex = this.pendingEntries.findIndex(
        (candidate) => candidate.level === "debug" || candidate.level === "info"
      );
      this.pendingEntries.splice(discardIndex < 0 ? 0 : discardIndex, 1);
    }
    this.pendingEntries.push(entry);
  }

  private async flushPending(): Promise<void> {
    if (!this.persistence || this.pendingEntries.length === 0) return;
    const entries = this.pendingEntries.splice(0);
    try {
      await this.persistence.append(entries);
    } catch (error) {
      this.pendingEntries.unshift(...entries);
      throw error;
    }
  }

  private requirePersistence(): LogPersistence {
    if (!this.persistence) {
      throw new Error("Rust log persistence is not initialized.");
    }
    return this.persistence;
  }
}
