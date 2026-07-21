import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from "electron";

import {
  getPendingDurableOrigins,
  removeDurableStorageForOrigin,
  type EmbeddedStorageOriginSeed,
  type EmbeddedStorageSeed
} from "./EncryptedSessionStorageSeedStore";

export type EmbeddedStorageBootstrapFailureReason =
  | "cancelled"
  | "completion_payload_rejected"
  | "completion_timeout"
  | "navigation_failed"
  | "origin_mismatch"
  | "preload_error"
  | "renderer_gone"
  | "seed_request_rejected"
  | "seed_unavailable"
  | "storage_restore_failed"
  | "window_destroyed";

export interface EmbeddedStorageBootstrapCompleted {
  cacheEntryCount: number;
  failureReason?: EmbeddedStorageBootstrapFailureReason;
  failureStage?: "cache_storage" | "indexed_db";
  indexedDbRecordCount: number;
  origin: string;
  success: boolean;
}

export interface EmbeddedStorageBootstrapSummary {
  attemptedOriginCount: number;
  cacheEntryCount: number;
  cancelledOriginCount: number;
  failedOriginCount: number;
  failureReasons: Partial<Record<EmbeddedStorageBootstrapFailureReason, number>>;
  indexedDbRecordCount: number;
  localStorageKeyCount: number;
  persistenceFailed: boolean;
  succeededOriginCount: number;
}

export interface EmbeddedStorageBootstrapDiagnostic {
  cacheEntryCount: number;
  elapsedMs: number;
  event: "cancelled" | "completed" | "failed" | "started";
  failureReason?: EmbeddedStorageBootstrapFailureReason;
  failureStage?: "cache_storage" | "indexed_db";
  indexedDbRecordCount: number;
  origin: string;
  roleId: string;
  webContentsId: number;
}

interface PendingBootstrap {
  completionTimeout?: ReturnType<typeof setTimeout>;
  handshakeTimeout?: ReturnType<typeof setTimeout>;
  origin: string;
  resolve: (result: EmbeddedStorageBootstrapCompleted) => void;
  roleId: string;
  seed: EmbeddedStorageOriginSeed;
  settled: boolean;
  startedAt: number;
  webContents: WebContents;
}

interface EmbeddedStorageBootstrapperOptions {
  bootstrapPreloadPath: string;
  completionTimeoutMs?: number;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  flushStorageData?: (partition: string) => Promise<void>;
  handshakeTimeoutMs?: number;
  loadSeed: (roleId: string) => Promise<EmbeddedStorageSeed | undefined>;
  now?: () => number;
  onDiagnostic?: (diagnostic: EmbeddedStorageBootstrapDiagnostic) => void;
  saveSeed: (roleId: string, seed: EmbeddedStorageSeed) => Promise<boolean>;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 20_000;

/** Restores IndexedDB and CacheStorage in a short-lived isolated document. */
export class EmbeddedStorageBootstrapper {
  private readonly completionTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly now: () => number;
  private readonly pendingByWebContentsId = new Map<number, PendingBootstrap>();

  constructor(private readonly options: EmbeddedStorageBootstrapperOptions) {
    this.completionTimeoutMs = options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  consumeSeed(webContentsId: number, origin: string): EmbeddedStorageOriginSeed | undefined {
    const pending = this.pendingByWebContentsId.get(webContentsId);
    if (!pending) return undefined;
    if (pending.origin !== origin) {
      this.reject(webContentsId, "origin_mismatch");
      return undefined;
    }
    if (pending.handshakeTimeout) clearTimeout(pending.handshakeTimeout);
    pending.handshakeTimeout = undefined;
    if (!pending.completionTimeout) {
      pending.completionTimeout = setTimeout(
        () => this.reject(webContentsId, "completion_timeout"),
        this.completionTimeoutMs
      );
    }
    return {
      ...(pending.seed.indexedDb ? { indexedDb: structuredClone(pending.seed.indexedDb) } : {}),
      ...(pending.seed.cacheStorage ? { cacheStorage: structuredClone(pending.seed.cacheStorage) } : {})
    };
  }

  complete(webContentsId: number, result: Omit<EmbeddedStorageBootstrapCompleted, "failureReason">): void {
    const pending = this.pendingByWebContentsId.get(webContentsId);
    if (!pending) return;
    if (pending.origin !== result.origin) {
      this.reject(webContentsId, "origin_mismatch");
      return;
    }
    this.settle(webContentsId, result.success
      ? result
      : { ...result, failureReason: "storage_restore_failed" });
  }

  reject(webContentsId: number, reason: EmbeddedStorageBootstrapFailureReason): void {
    const pending = this.pendingByWebContentsId.get(webContentsId);
    if (!pending) return;
    this.settle(webContentsId, {
      cacheEntryCount: 0,
      failureReason: reason,
      indexedDbRecordCount: 0,
      origin: pending.origin,
      success: false
    });
  }

  async prepareRole(
    roleId: string,
    partition: string,
    signal?: AbortSignal
  ): Promise<EmbeddedStorageBootstrapSummary> {
    let seed = await this.options.loadSeed(roleId);
    const summary: EmbeddedStorageBootstrapSummary = {
      attemptedOriginCount: 0,
      cacheEntryCount: 0,
      cancelledOriginCount: 0,
      failedOriginCount: 0,
      failureReasons: {},
      indexedDbRecordCount: 0,
      localStorageKeyCount: 0,
      persistenceFailed: false,
      succeededOriginCount: 0
    };
    if (!seed) return summary;

    for (const origin of getPendingDurableOrigins(seed)) {
      if (signal?.aborted) break;
      const originSeed = seed.origins[origin];
      if (!originSeed) continue;
      summary.attemptedOriginCount += 1;
      const result = await this.bootstrapOrigin(roleId, partition, origin, originSeed, signal);
      if (!result.success) {
        const reason = result.failureReason ?? "storage_restore_failed";
        summary.failureReasons[reason] = (summary.failureReasons[reason] ?? 0) + 1;
        if (reason === "cancelled") {
          summary.cancelledOriginCount += 1;
          break;
        }
        summary.failedOriginCount += 1;
        continue;
      }

      summary.succeededOriginCount += 1;
      summary.cacheEntryCount += result.cacheEntryCount;
      summary.indexedDbRecordCount += result.indexedDbRecordCount;
      seed = removeDurableStorageForOrigin(seed, origin);
      if (!await this.options.saveSeed(roleId, seed)) summary.persistenceFailed = true;
    }

    if (summary.succeededOriginCount > 0) {
      await this.options.flushStorageData?.(partition).catch(() => undefined);
    }
    return summary;
  }

  private async bootstrapOrigin(
    roleId: string,
    partition: string,
    origin: string,
    seed: EmbeddedStorageOriginSeed,
    signal?: AbortSignal
  ): Promise<EmbeddedStorageBootstrapCompleted> {
    const probe = this.options.createWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition,
        preload: this.options.bootstrapPreloadPath,
        sandbox: true
      }
    });
    const webContents = probe.webContents;
    const webContentsId = webContents.id;
    const startedAt = this.now();
    let removeAbortListener: () => void = () => undefined;
    const completed = new Promise<EmbeddedStorageBootstrapCompleted>((resolve) => {
      const pending: PendingBootstrap = {
        origin,
        resolve,
        roleId,
        seed: cloneOriginSeed(seed),
        settled: false,
        startedAt,
        webContents
      };
      pending.handshakeTimeout = setTimeout(
        () => this.reject(webContentsId, "seed_unavailable"),
        this.handshakeTimeoutMs
      );
      this.pendingByWebContentsId.set(webContentsId, pending);
    });

    this.emitDiagnostic("started", roleId, origin, webContentsId, startedAt, {
      cacheEntryCount: 0,
      indexedDbRecordCount: 0
    });
    const onPreloadError = () => this.reject(webContentsId, "preload_error");
    const onRenderProcessGone = () => this.reject(webContentsId, "renderer_gone");
    const onDestroyed = () => this.reject(webContentsId, "window_destroyed");
    const onDidFailLoad = (
      _event: unknown,
      _errorCode: number,
      _errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean
    ) => {
      if (isMainFrame) this.reject(webContentsId, "navigation_failed");
    };
    webContents.once("preload-error", onPreloadError);
    webContents.once("render-process-gone", onRenderProcessGone);
    webContents.once("destroyed", onDestroyed);
    webContents.on("did-fail-load", onDidFailLoad);
    if (signal) {
      const onAbort = () => this.reject(webContentsId, "cancelled");
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    }

    void webContents.loadURL(`${origin}/`).catch(() => {
      this.reject(webContentsId, "navigation_failed");
    });

    try {
      return await completed;
    } finally {
      removeAbortListener();
      webContents.removeListener("preload-error", onPreloadError);
      webContents.removeListener("render-process-gone", onRenderProcessGone);
      webContents.removeListener("destroyed", onDestroyed);
      webContents.removeListener("did-fail-load", onDidFailLoad);
      const pending = this.pendingByWebContentsId.get(webContentsId);
      if (pending?.handshakeTimeout) clearTimeout(pending.handshakeTimeout);
      if (pending?.completionTimeout) clearTimeout(pending.completionTimeout);
      this.pendingByWebContentsId.delete(webContentsId);
      if (!probe.isDestroyed()) probe.destroy();
    }
  }

  private settle(webContentsId: number, result: EmbeddedStorageBootstrapCompleted): void {
    const pending = this.pendingByWebContentsId.get(webContentsId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (pending.handshakeTimeout) clearTimeout(pending.handshakeTimeout);
    if (pending.completionTimeout) clearTimeout(pending.completionTimeout);
    const event = result.success
      ? "completed"
      : result.failureReason === "cancelled" ? "cancelled" : "failed";
    this.emitDiagnostic(event, pending.roleId, pending.origin, webContentsId, pending.startedAt, result);
    pending.resolve(result);
  }

  private emitDiagnostic(
    event: EmbeddedStorageBootstrapDiagnostic["event"],
    roleId: string,
    origin: string,
    webContentsId: number,
    startedAt: number,
    result: Pick<EmbeddedStorageBootstrapCompleted, "cacheEntryCount" | "indexedDbRecordCount"> &
      Partial<Pick<EmbeddedStorageBootstrapCompleted, "failureReason" | "failureStage">>
  ): void {
    this.options.onDiagnostic?.({
      cacheEntryCount: result.cacheEntryCount,
      elapsedMs: Math.max(0, this.now() - startedAt),
      event,
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      ...(result.failureStage ? { failureStage: result.failureStage } : {}),
      indexedDbRecordCount: result.indexedDbRecordCount,
      origin,
      roleId,
      webContentsId
    });
  }
}

function cloneOriginSeed(seed: EmbeddedStorageOriginSeed): EmbeddedStorageOriginSeed {
  return structuredClone(seed);
}
