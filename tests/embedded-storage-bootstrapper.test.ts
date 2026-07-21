import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EmbeddedStorageBootstrapper
} from "../src/main/browser/EmbeddedStorageBootstrapper";
import type { EmbeddedStorageSeed } from "../src/main/browser/EncryptedSessionStorageSeedStore";

afterEach(() => vi.useRealTimers());

describe("EmbeddedStorageBootstrapper", () => {
  it("injects only durable data and retains document storage after success", async () => {
    let seed: EmbeddedStorageSeed = createSeed();
    const bootstrapperRef: { current?: EmbeddedStorageBootstrapper } = {};
    const window = createMockWindow(81, async (url) => {
      const origin = new URL(url).origin;
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
    });
    const saveSeed = vi.fn(async (_roleId: string, next: EmbeddedStorageSeed) => {
      seed = next;
      return true;
    });
    const flushStorageData = vi.fn().mockResolvedValue(undefined);
    const bootstrapper = new EmbeddedStorageBootstrapper({
      bootstrapPreloadPath: "/app/out/preload/embedded-storage-bootstrap.cjs",
      createWindow: () => window as never,
      flushStorageData,
      loadSeed: async () => seed,
      saveSeed
    });
    bootstrapperRef.current = bootstrapper;

    await expect(bootstrapper.prepareRole("role-1", "persist:rion-role-role-1")).resolves.toEqual({
      attemptedOriginCount: 1,
      cacheEntryCount: 1,
      cancelledOriginCount: 0,
      failedOriginCount: 0,
      failureReasons: {},
      indexedDbRecordCount: 1,
      localStorageKeyCount: 0,
      persistenceFailed: false,
      succeededOriginCount: 1
    });
    expect(saveSeed).toHaveBeenCalledWith("role-1", {
      origins: {
        "https://game.example.test": {
          localStorage: { language: "zh-TW" },
          sessionStorage: { gameSession: "opaque-token" }
        }
      },
      version: 2
    });
    expect(flushStorageData).toHaveBeenCalledWith("persist:rion-role-role-1");
    expect(window.destroy).toHaveBeenCalledOnce();
  });

  it("does not bootstrap a localStorage-only seed", async () => {
    const createWindow = vi.fn();
    const bootstrapper = new EmbeddedStorageBootstrapper({
      bootstrapPreloadPath: "/app/bootstrap.cjs",
      createWindow: createWindow as never,
      loadSeed: async () => ({
        origins: { "https://game.example.test": { localStorage: { language: "zh-TW" } } },
        version: 2
      }),
      saveSeed: vi.fn()
    });

    await expect(bootstrapper.prepareRole("role-1", "persist:role-1")).resolves.toMatchObject({
      attemptedOriginCount: 0
    });
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("settles navigation failures immediately and retains the seed", async () => {
    const seed = createSeed();
    const saveSeed = vi.fn();
    const window = createMockWindow(82, async () => {
      throw new Error("origin unavailable");
    });
    const bootstrapper = new EmbeddedStorageBootstrapper({
      bootstrapPreloadPath: "/app/bootstrap.cjs",
      createWindow: () => window as never,
      loadSeed: async () => seed,
      saveSeed: saveSeed as never
    });

    await expect(bootstrapper.prepareRole("role-1", "persist:role-1")).resolves.toMatchObject({
      attemptedOriginCount: 1,
      failedOriginCount: 1,
      failureReasons: { navigation_failed: 1 },
      succeededOriginCount: 0
    });
    expect(saveSeed).not.toHaveBeenCalled();
    expect(window.destroy).toHaveBeenCalledOnce();
  });

  it("settles preload, renderer, rejected completion, and storage failures exactly once", async () => {
    const scenarios = [
      {
        id: 87,
        expected: "preload_error",
        act: (bootstrapper: EmbeddedStorageBootstrapper, window: ReturnType<typeof createMockWindow>) => {
          window.webContents.emit("preload-error", {}, "/app/bootstrap.cjs", new Error("preload failed"));
          bootstrapper.reject(87, "renderer_gone");
        }
      },
      {
        id: 88,
        expected: "renderer_gone",
        act: (_bootstrapper: EmbeddedStorageBootstrapper, window: ReturnType<typeof createMockWindow>) => {
          window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
        }
      },
      {
        id: 89,
        expected: "completion_payload_rejected",
        act: (bootstrapper: EmbeddedStorageBootstrapper) => {
          bootstrapper.reject(89, "completion_payload_rejected");
        }
      },
      {
        id: 90,
        expected: "storage_restore_failed",
        act: (bootstrapper: EmbeddedStorageBootstrapper) => {
          bootstrapper.consumeSeed(90, "https://game.example.test");
          bootstrapper.complete(90, {
            cacheEntryCount: 0,
            failureStage: "indexed_db",
            indexedDbRecordCount: 0,
            origin: "https://game.example.test",
            success: false
          });
        }
      }
    ] as const;

    for (const scenario of scenarios) {
      const diagnostics = vi.fn();
      const window = createMockWindow(scenario.id, () => new Promise<void>(() => undefined));
      const bootstrapper = new EmbeddedStorageBootstrapper({
        bootstrapPreloadPath: "/app/bootstrap.cjs",
        createWindow: () => window as never,
        loadSeed: async () => createSeed(),
        onDiagnostic: diagnostics,
        saveSeed: vi.fn()
      });
      const result = bootstrapper.prepareRole("role-1", "persist:role-1");
      await vi.waitFor(() => expect(window.webContents.loadURL).toHaveBeenCalled());
      scenario.act(bootstrapper, window);

      await expect(result).resolves.toMatchObject({ failureReasons: { [scenario.expected]: 1 } });
      expect(window.destroy).toHaveBeenCalledOnce();
      expect(diagnostics).toHaveBeenLastCalledWith(expect.objectContaining({
        event: "failed",
        failureReason: scenario.expected,
        roleId: "role-1",
        webContentsId: scenario.id
      }));
    }
  });

  it("distinguishes handshake timeout, completion timeout, origin mismatch, and cancellation", async () => {
    vi.useFakeTimers();
    const scenarios = [
      { id: 83, expected: "seed_unavailable", act: (_bootstrapper: EmbeddedStorageBootstrapper) => undefined, advance: 5_000 },
      { id: 84, expected: "completion_timeout", act: (bootstrapper: EmbeddedStorageBootstrapper) => {
        bootstrapper.consumeSeed(84, "https://game.example.test");
      }, advance: 20_000 },
      { id: 85, expected: "origin_mismatch", act: (bootstrapper: EmbeddedStorageBootstrapper) => {
        bootstrapper.consumeSeed(85, "https://wrong.example.test");
      }, advance: 0 }
    ] as const;

    for (const scenario of scenarios) {
      const window = createMockWindow(scenario.id, () => new Promise<void>(() => undefined));
      const bootstrapper = new EmbeddedStorageBootstrapper({
        bootstrapPreloadPath: "/app/bootstrap.cjs",
        createWindow: () => window as never,
        loadSeed: async () => createSeed(),
        saveSeed: vi.fn()
      });
      const result = bootstrapper.prepareRole("role-1", "persist:role-1");
      await vi.waitFor(() => expect(window.webContents.loadURL).toHaveBeenCalled());
      scenario.act(bootstrapper);
      await vi.advanceTimersByTimeAsync(scenario.advance);
      await expect(result).resolves.toMatchObject({ failureReasons: { [scenario.expected]: 1 } });
      expect(window.destroy).toHaveBeenCalledOnce();
    }

    const controller = new AbortController();
    const cancelledWindow = createMockWindow(86, () => new Promise<void>(() => undefined));
    const cancelledBootstrapper = new EmbeddedStorageBootstrapper({
      bootstrapPreloadPath: "/app/bootstrap.cjs",
      createWindow: () => cancelledWindow as never,
      loadSeed: async () => createSeed(),
      saveSeed: vi.fn()
    });
    const cancelled = cancelledBootstrapper.prepareRole("role-1", "persist:role-1", controller.signal);
    await vi.waitFor(() => expect(cancelledWindow.webContents.loadURL).toHaveBeenCalled());
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({
      cancelledOriginCount: 1,
      failureReasons: { cancelled: 1 }
    });
    expect(cancelledWindow.destroy).toHaveBeenCalledOnce();
  });
});

function createMockWindow(id: number, load: (url: string) => Promise<void> | void) {
  const webContents = Object.assign(new EventEmitter(), {
    id,
    loadURL: vi.fn(async (url: string) => load(url))
  });
  return {
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
    webContents
  };
}

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
        localStorage: { language: "zh-TW" },
        sessionStorage: { gameSession: "opaque-token" }
      }
    },
    version: 2
  };
}
