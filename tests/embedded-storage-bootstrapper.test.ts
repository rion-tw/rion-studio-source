import { describe, expect, it, vi } from "vitest";

import {
  EmbeddedStorageBootstrapper
} from "../src/main/browser/EmbeddedStorageBootstrapper";
import type { EmbeddedStorageSeed } from "../src/main/browser/EncryptedSessionStorageSeedStore";

describe("EmbeddedStorageBootstrapper", () => {
  it("injects pending durable data in a hidden partition and retains only document state after success", async () => {
    let seed: EmbeddedStorageSeed = createSeed();
    const bootstrapperRef: { current?: EmbeddedStorageBootstrapper } = {};
    const destroy = vi.fn();
    const webContents = {
      id: 81,
      loadURL: vi.fn(async (origin: string) => {
        expect(bootstrapperRef.current?.consumeSeed(81, origin)).toEqual({
          cacheStorage: seed.origins[origin].cacheStorage,
          indexedDb: seed.origins[origin].indexedDb
        });
        bootstrapperRef.current?.complete(81, {
          cacheEntryCount: 1,
          indexedDbRecordCount: 1,
          origin,
          success: true
        });
      })
    };
    const createWindow = vi.fn(() => ({
      destroy,
      isDestroyed: vi.fn(() => false),
      webContents
    }));
    const saveSeed = vi.fn(async (_roleId: string, next: EmbeddedStorageSeed) => {
      seed = next;
      return true;
    });
    const flushStorageData = vi.fn().mockResolvedValue(undefined);
    const bootstrapper = new EmbeddedStorageBootstrapper({
      bootstrapPreloadPath: "/app/out/preload/embedded-storage-bootstrap.cjs",
      createWindow: createWindow as never,
      flushStorageData,
      loadSeed: async () => seed,
      saveSeed
    });
    bootstrapperRef.current = bootstrapper;

    await expect(bootstrapper.prepareRole("role-1", "persist:rion-role-role-1")).resolves.toEqual({
      attemptedOriginCount: 1,
      cacheEntryCount: 1,
      failedOriginCount: 0,
      indexedDbRecordCount: 1,
      persistenceFailed: false,
      succeededOriginCount: 1
    });
    expect(createWindow).toHaveBeenCalledWith(expect.objectContaining({
      show: false,
      webPreferences: expect.objectContaining({ partition: "persist:rion-role-role-1", sandbox: true })
    }));
    expect(saveSeed).toHaveBeenCalledWith("role-1", {
      origins: { "https://game.example.test": { sessionStorage: { gameSession: "opaque-token" } } },
      version: 2
    });
    expect(flushStorageData).toHaveBeenCalledWith("persist:rion-role-role-1");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("leaves failed payloads pending for a later embedded launch", async () => {
    const seed = createSeed();
    const saveSeed = vi.fn();
    const bootstrapper = new EmbeddedStorageBootstrapper({
      bootstrapPreloadPath: "/app/out/preload/embedded-storage-bootstrap.cjs",
      createWindow: (() => ({
        destroy: vi.fn(),
        isDestroyed: vi.fn(() => false),
        webContents: {
          id: 82,
          loadURL: vi.fn().mockRejectedValue(new Error("origin unavailable"))
        }
      })) as never,
      loadSeed: async () => seed,
      saveSeed: saveSeed as never
    });

    await expect(bootstrapper.prepareRole("role-1", "persist:rion-role-role-1")).resolves.toMatchObject({
      attemptedOriginCount: 1,
      failedOriginCount: 1,
      succeededOriginCount: 0
    });
    expect(saveSeed).not.toHaveBeenCalled();
  });
});

function createSeed(): EmbeddedStorageSeed {
  return {
    origins: {
      "https://game.example.test": {
        cacheStorage: [{
          bodyBase64: "b2s=",
          cacheName: "auth",
          requestHeaders: [],
          requestUrl: "https://game.example.test/session",
          responseHeaders: [["content-type", "text/plain"]],
          responseStatus: 200,
          responseStatusText: "OK"
        }],
        indexedDb: [{
          name: "auth",
          objectStores: [{
            autoIncrement: false,
            indexes: [],
            keyPath: null,
            name: "tokens",
            records: [{ key: "current", value: { type: "object", entries: [["ready", true]] } }]
          }],
          version: 1
        }],
        sessionStorage: { gameSession: "opaque-token" }
      }
    },
    version: 2
  };
}
