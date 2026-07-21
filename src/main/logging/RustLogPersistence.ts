import { dirname } from "node:path";

import type {
  LogEntry,
  LogLevel,
  LogPage,
  LogQuery,
  LogStorageStatus
} from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";
import {
  LOG_MAX_BYTES,
  LOG_RETENTION_DAYS,
  type LogPersistence
} from "./LogService";

interface NativeLogStatus {
  databasePath: string;
  entryCount: number;
  maxBytes: number;
  newestTimestamp?: string;
  oldestTimestamp?: string;
  retentionDays: number;
  totalBytes: number;
}

export class RustLogPersistence implements LogPersistence {
  constructor(private readonly core: AppCoreClient) {}

  async append(entries: LogEntry[]): Promise<void> {
    await this.core.invoke({ type: "logsAppend", entries });
  }

  async clear(): Promise<void> {
    await this.core.invoke({ type: "logsClear" });
  }

  async exportJsonl(): Promise<string> {
    return (await this.core.invoke<{ jsonl: string }>({ type: "logsExport" })).jsonl;
  }

  async exportJsonlTo(path: string): Promise<void> {
    await this.core.invoke({ type: "logsExportTo", path });
  }

  async getStatus(currentLevel: LogLevel): Promise<LogStorageStatus> {
    const status = await this.core.invoke<NativeLogStatus>({ type: "logsStatus" });
    return {
      currentLevel,
      fileCount: status.entryCount > 0 ? 1 : 0,
      totalBytes: status.totalBytes,
      oldestTimestamp: status.oldestTimestamp,
      newestTimestamp: status.newestTimestamp,
      retentionDays: status.retentionDays ?? LOG_RETENTION_DAYS,
      maxBytes: status.maxBytes ?? LOG_MAX_BYTES,
      directory: dirname(status.databasePath)
    };
  }

  query(query: LogQuery): Promise<LogPage> {
    return this.core.invoke<LogPage>({ type: "logsQuery", query });
  }
}
