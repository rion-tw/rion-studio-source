import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, truncate, unlink } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import { LOG_LEVELS, LOG_SOURCES, type LogEntry, type LogLevel, type LogPage, type LogQuery, type LogSource, type LogStorageStatus } from "../../shared/types";
import { sanitizeError, sanitizeText, sanitizeValue } from "./logSanitizer";

const LEVEL_VALUE: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const FILE_LIMIT = 10 * 1024 * 1024;
export const LOG_RETENTION_DAYS = 14;
export const LOG_MAX_BYTES = 100 * 1024 * 1024;

export interface LogServiceOptions {
  userDataPath: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
  appVersion?: string;
}

export class LogService extends EventEmitter {
  readonly directory: string;
  readonly sessionId = randomUUID();
  private currentLevel: LogLevel = "info";
  private currentFile: string;
  private sequence = 0;
  private queue = Promise.resolve();
  private readonly now: () => Date;
  private readonly userDataPath: string;

  constructor(private readonly options: LogServiceOptions) {
    super();
    this.userDataPath = options.userDataPath;
    this.directory = join(options.userDataPath, "logs");
    this.now = options.now ?? (() => new Date());
    this.currentFile = join(this.directory, `${this.filePrefix()}-01.jsonl`);
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.enforceRetention();
    this.info("main", "app_session_started", "Application logging started.", {
      appVersion: this.options.appVersion,
      platform: this.options.platform ?? process.platform,
      arch: process.arch
    });
  }

  debug(source: LogSource, event: string, message: string, context?: Record<string, unknown>): void { this.log("debug", source, event, message, context); }
  info(source: LogSource, event: string, message: string, context?: Record<string, unknown>): void { this.log("info", source, event, message, context); }
  warn(source: LogSource, event: string, message: string, context?: Record<string, unknown>, error?: unknown): void { this.log("warn", source, event, message, context, error); }
  error(source: LogSource, event: string, message: string, error?: unknown, context?: Record<string, unknown>): void { this.log("error", source, event, message, context, error); }

  log(level: LogLevel, source: LogSource, event: string, message: string, context?: Record<string, unknown>, error?: unknown): void {
    if (LEVEL_VALUE[level] < LEVEL_VALUE[this.currentLevel]) return;
    const timestamp = this.now().toISOString();
    const entry: LogEntry = {
      id: `${this.sessionId}:${++this.sequence}`,
      timestamp,
      level,
      source,
      event: sanitizeText(event, this.userDataPath).slice(0, 120),
      message: sanitizeText(message, this.userDataPath),
      sessionId: this.sessionId
    };
    const sanitized = sanitizeValue(context, this.userDataPath);
    if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) entry.context = sanitized as Record<string, unknown>;
    if (error instanceof Error) entry.error = sanitizeError(error, this.userDataPath);
    else if (error !== undefined) entry.error = { name: "Error", message: sanitizeText(String(error), this.userDataPath) };
    this.emit("entry", entry);
    this.queue = this.queue.then(() => this.writeEntry(entry)).catch((writeError) => {
      process.stderr.write(`Rion Studio log write failed: ${String(writeError)}\n`);
    });
  }

  setLevel(level: LogLevel): void {
    if (!LOG_LEVELS.includes(level)) throw new Error("Invalid log level.");
    this.currentLevel = level;
    this.info("main", "log_level_changed", `Log level changed to ${level}.`);
  }

  async flush(): Promise<void> { await this.queue; }

  async getStatus(): Promise<LogStorageStatus> {
    await this.flush();
    const files = await this.listFiles();
    let totalBytes = 0;
    let oldest: string | undefined;
    let newest: string | undefined;
    for (const file of files) {
      const details = await stat(join(this.directory, file));
      totalBytes += details.size;
      const timestamp = details.mtime.toISOString();
      oldest = !oldest || timestamp < oldest ? timestamp : oldest;
      newest = !newest || timestamp > newest ? timestamp : newest;
    }
    return { currentLevel: this.currentLevel, fileCount: files.length, totalBytes, oldestTimestamp: oldest, newestTimestamp: newest, retentionDays: LOG_RETENTION_DAYS, maxBytes: LOG_MAX_BYTES, directory: this.directory };
  }

  async query(query: LogQuery = {}): Promise<LogPage> {
    validateQuery(query);
    await this.flush();
    const entries = await this.readEntries();
    const search = query.search?.trim().toLocaleLowerCase();
    const filtered = entries.filter((entry) =>
      (!query.levels?.length || query.levels.includes(entry.level)) &&
      (!query.sources?.length || query.sources.includes(entry.source)) &&
      (!query.from || entry.timestamp >= query.from) && (!query.to || entry.timestamp <= query.to) &&
      (!search || JSON.stringify(entry).toLocaleLowerCase().includes(search))
    ).sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
    const offset = query.cursor ? Number(query.cursor) : 0;
    const limit = Math.min(query.limit ?? 100, 200);
    const page = filtered.slice(offset, offset + limit);
    return { entries: page, ...(offset + limit < filtered.length ? { nextCursor: String(offset + limit) } : {}) };
  }

  async clear(): Promise<void> {
    await this.flush();
    for (const file of await this.listFiles()) {
      const path = join(this.directory, file);
      if (path === this.currentFile) await truncate(path, 0).catch(() => undefined);
      else await unlink(path).catch(() => undefined);
    }
    this.info("main", "logs_cleared", "Application logs were cleared by the user.");
  }

  async getFiles(): Promise<Array<{ name: string; data: Buffer }>> {
    await this.flush();
    return Promise.all((await this.listFiles()).map(async (name) => ({ name, data: await readFile(join(this.directory, name)) })));
  }

  private filePrefix(): string { return `${this.now().toISOString().slice(0, 10)}-${this.sessionId}`; }
  private async writeEntry(entry: LogEntry): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    const size = await stat(this.currentFile).then((value) => value.size).catch(() => 0);
    if (size + Buffer.byteLength(line) > FILE_LIMIT) {
      const next = String(Number(this.currentFile.match(/-(\d+)\.jsonl$/)?.[1] ?? "1") + 1).padStart(2, "0");
      this.currentFile = join(this.directory, `${this.filePrefix()}-${next}.jsonl`);
      await this.enforceRetention();
    }
    await appendFile(this.currentFile, line, "utf8");
  }

  private async listFiles(): Promise<string[]> {
    return (await readdir(this.directory).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort();
  }

  private async readEntries(): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    for (const file of await this.listFiles()) {
      const text = await readFile(join(this.directory, file), "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        if (!line) continue;
        try { entries.push(JSON.parse(line) as LogEntry); } catch { /* Ignore a partial final line after a crash. */ }
      }
    }
    return entries;
  }

  private async enforceRetention(): Promise<void> {
    const cutoff = this.now().getTime() - LOG_RETENTION_DAYS * 86_400_000;
    const files = await this.listFiles();
    const details = await Promise.all(files.map(async (name) => ({ name, path: join(this.directory, name), stat: await stat(join(this.directory, name)) })));
    for (const file of details) if (file.path !== this.currentFile && file.stat.mtimeMs < cutoff) await unlink(file.path).catch(() => undefined);
    const remaining = (await Promise.all((await this.listFiles()).map(async (name) => ({ name, path: join(this.directory, name), stat: await stat(join(this.directory, name)) })))).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    let total = remaining.reduce((sum, file) => sum + file.stat.size, 0);
    for (const file of remaining) {
      if (total <= LOG_MAX_BYTES) break;
      if (file.path === this.currentFile) continue;
      await unlink(file.path).catch(() => undefined);
      total -= file.stat.size;
    }
  }
}

function validateQuery(query: LogQuery): void {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("Invalid log query.");
  if (query.levels !== undefined && (!Array.isArray(query.levels) || query.levels.some((level) => !LOG_LEVELS.includes(level)))) throw new Error("Invalid log level filter.");
  if (query.sources !== undefined && (!Array.isArray(query.sources) || query.sources.some((source) => !LOG_SOURCES.includes(source)))) throw new Error("Invalid log source filter.");
  if (query.search && (typeof query.search !== "string" || query.search.length > 200)) throw new Error("Invalid log search.");
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200)) throw new Error("Invalid log page size.");
  if (query.cursor !== undefined && !/^\d+$/.test(query.cursor)) throw new Error("Invalid log cursor.");
  for (const value of [query.from, query.to]) if (value && Number.isNaN(Date.parse(value))) throw new Error("Invalid log date.");
}
