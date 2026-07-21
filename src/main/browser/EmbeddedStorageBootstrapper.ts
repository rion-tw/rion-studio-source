import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

import {
  getPendingDurableOrigins,
  removeDurableStorageForOrigin,
  type EmbeddedStorageOriginSeed,
  type EmbeddedStorageSeed
} from "./EncryptedSessionStorageSeedStore";

export interface EmbeddedStorageBootstrapCompleted {
  cacheEntryCount: number;
  indexedDbRecordCount: number;
  origin: string;
  success: boolean;
}

export interface EmbeddedStorageBootstrapSummary {
  attemptedOriginCount: number;
  cacheEntryCount: number;
  failedOriginCount: number;
  indexedDbRecordCount: number;
  persistenceFailed: boolean;
  succeededOriginCount: number;
}

interface PendingBootstrap {
  origin: string;
  resolve: (result: EmbeddedStorageBootstrapCompleted) => void;
  seed: EmbeddedStorageOriginSeed;
}

interface EmbeddedStorageBootstrapperOptions {
  bootstrapPreloadPath: string;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  flushStorageData?: (partition: string) => Promise<void>;
  loadSeed: (roleId: string) => Promise<EmbeddedStorageSeed | undefined>;
  saveSeed: (roleId: string, seed: EmbeddedStorageSeed) => Promise<boolean>;
  timeoutMs?: number;
}

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 20_000;

/**
 * Restores durable browser APIs in a short-lived isolated Electron document.
 * Its IPC payload is only available to the bootstrap preload, never to the
 * website's main world or the app renderer.
 */
export class EmbeddedStorageBootstrapper {
  private readonly pendingByWebContentsId = new Map<number, PendingBootstrap>();
  private readonly timeoutMs: number;

  constructor(private readonly options: EmbeddedStorageBootstrapperOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  }

  consumeSeed(webContentsId: number, origin: string): EmbeddedStorageOriginSeed | undefined {
    const pending = this.pendingByWebContentsId.get(webContentsId);
    if (!pending || pending.origin !== origin) return undefined;
    return {
      ...(pending.seed.indexedDb ? { indexedDb: structuredClone(pending.seed.indexedDb) } : {}),
      ...(pending.seed.cacheStorage ? { cacheStorage: structuredClone(pending.seed.cacheStorage) } : {})
    };
  }

  complete(webContentsId: number, result: EmbeddedStorageBootstrapCompleted): void {
    const pending = this.pendingByWebContentsId.get(webContentsId);
    if (!pending || pending.origin !== result.origin) return;
    pending.resolve(result);
  }

  async prepareRole(roleId: string, partition: string): Promise<EmbeddedStorageBootstrapSummary> {
    let seed = await this.options.loadSeed(roleId);
    const summary: EmbeddedStorageBootstrapSummary = {
      attemptedOriginCount: 0,
      cacheEntryCount: 0,
      failedOriginCount: 0,
      indexedDbRecordCount: 0,
      persistenceFailed: false,
      succeededOriginCount: 0
    };
    if (!seed) return summary;

    for (const origin of getPendingDurableOrigins(seed)) {
      const originSeed = seed.origins[origin];
      if (!originSeed) continue;
      summary.attemptedOriginCount += 1;
      const result = await this.bootstrapOrigin(partition, origin, originSeed);
      if (!result.success) {
        summary.failedOriginCount += 1;
        continue;
      }

      summary.succeededOriginCount += 1;
      summary.cacheEntryCount += result.cacheEntryCount;
      summary.indexedDbRecordCount += result.indexedDbRecordCount;
      seed = removeDurableStorageForOrigin(seed, origin);
      if (!await this.options.saveSeed(roleId, seed)) {
        summary.persistenceFailed = true;
      }
    }

    if (summary.succeededOriginCount > 0) {
      await this.options.flushStorageData?.(partition).catch(() => undefined);
    }
    return summary;
  }

  private async bootstrapOrigin(
    partition: string,
    origin: string,
    seed: EmbeddedStorageOriginSeed
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = new Promise<EmbeddedStorageBootstrapCompleted>((resolve) => {
      this.pendingByWebContentsId.set(webContentsId, { origin, resolve, seed: cloneOriginSeed(seed) });
      timeout = setTimeout(() => resolve({
        cacheEntryCount: 0,
        indexedDbRecordCount: 0,
        origin,
        success: false
      }), this.timeoutMs);
    });

    try {
      await webContents.loadURL(origin);
      return await completed;
    } catch {
      return { cacheEntryCount: 0, indexedDbRecordCount: 0, origin, success: false };
    } finally {
      if (timeout) clearTimeout(timeout);
      this.pendingByWebContentsId.delete(webContentsId);
      if (!probe.isDestroyed()) probe.destroy();
    }
  }
}

function cloneOriginSeed(seed: EmbeddedStorageOriginSeed): EmbeddedStorageOriginSeed {
  return structuredClone(seed);
}
