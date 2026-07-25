import { EventEmitter } from "node:events";

import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { CoreEvent } from "../src/shared/generated";
import type { CompatibilityCoreEffectAction } from "../src/main/core/ElectronEffectExecutor";
import type { GameCompatibilityReport } from "../src/shared/types";
import { GameCompatibilityManager } from "../src/main/games/GameCompatibilityManager";
import { v1Case } from "./helpers/v1Parity";

const report: GameCompatibilityReport = {
  gameId: "game-1",
  checkedAt: "2026-07-15T00:00:01.000Z",
  configurationFingerprint: "rust-fingerprint",
  isStale: false,
  load: { state: "available", durationMs: 10, finalOrigin: "https://example.test" },
  graphics: { webgl: "available", webgl2: "available", webgpu: "unavailable" },
  systemChrome: { state: "available" },
  recommendation: { reason: "embedded_available" },
  observations: {}
};

describe("GameCompatibilityManager", () => {
  it("sends one high-level compatibility intent to Rust", async () => {
    const invoke = vi.fn(async (command: { type: string }) =>
      command.type === "compatibilityStatuses" ? [] : report
    );
    const { manager } = createManager({ invoke });

    await expect(manager.runCheck("game-1")).resolves.toEqual(report);

    expect(invoke).toHaveBeenCalledWith({
      type: "engineCompatibilityCacheDeleteGame",
      gameId: "game-1"
    });
    expect(invoke).toHaveBeenLastCalledWith({
      type: "compatibilityRun",
      gameId: "game-1",
      versions: { chrome: "140.0.0", electron: "40.0.0" }
    });
  });

  it("executes create, session, load, raw probe, and cleanup Electron effects", async () => {
    const windows: FakeCompatibilityWindow[] = [];
    const applyCdnCompatibility = vi.fn(async () => undefined);
    const applyProxy = vi.fn(async () => undefined);
    const { manager, invoke } = createManager({
      applyCdnCompatibility,
      applyProxy,
      createWindow: (options) => {
        const window = new FakeCompatibilityWindow(options);
        windows.push(window);
        return window.asBrowserWindow();
      }
    });

    await manager.executeEffect(effect({
      type: "compatibilityCreateWindow",
      plan: {
        gameId: "game-1",
        gameName: "Example",
        launchUrl: "https://example.test/play",
        startedAt: "2026-07-15T00:00:00.000Z"
      }
    }));
    const created = windows[0]!;
    await manager.executeEffect(effect({
      type: "compatibilityConfigureSession",
      gameId: "game-1"
    }));
    await expect(manager.executeEffect(effect({
      type: "compatibilityLoadUrl",
      gameId: "game-1",
      url: "https://example.test/play"
    }))).resolves.toEqual({ finalUrl: "https://example.test/play?token=private" });
    await expect(manager.executeEffect(effect({
      type: "compatibilityProbeGraphics",
      gameId: "game-1",
      source: "raw-probe"
    }))).resolves.toMatchObject({ webgl: "available" });
    created.clearCache.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(manager.executeEffect(effect({
      type: "compatibilityCleanupWindow",
      gameId: "game-1"
    }))).resolves.toBeUndefined();

    expect(created.options).toMatchObject({
      x: 100,
      y: 50,
      width: 1000,
      height: 700,
      show: false
    });
    expect(created.options.webPreferences?.partition).toMatch(/^rion-compatibility-/);
    expect(applyProxy).toHaveBeenCalledOnce();
    expect(applyCdnCompatibility).toHaveBeenCalledOnce();
    expect(created.show).toHaveBeenCalledOnce();
    expect(created.webContents.loadURL).toHaveBeenCalledWith("https://example.test/play");
    expect(created.webContents.executeJavaScript).toHaveBeenCalledWith("raw-probe");
    expect(created.destroy).toHaveBeenCalledOnce();
    expect(created.clearStorageData).toHaveBeenCalledOnce();
    expect(created.clearCache).toHaveBeenCalledOnce();
    expect(created.closeAllConnections).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith({
      type: "compatibilityCancel",
      gameId: "game-1"
    });
    await expect(manager.runCheck("game-1")).resolves.toMatchObject({
      gameId: "game-1",
      load: { state: "available", finalOrigin: "https://example.test" },
      graphics: { webgl: "available", webgl2: "available", webgpu: "unavailable" },
      recommendation: { reason: "embedded_available" },
      systemChrome: { state: "available" }
    });
    v1Case("browser-workspace-b36d189c65c3", () => {
      expect(created.options).toMatchObject({
        x: 100,
        y: 50,
        width: 1000,
        height: 700,
        show: false,
        webPreferences: {
          backgroundThrottling: true,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      expect(created.options.webPreferences?.partition).toMatch(/^rion-compatibility-/);
      expect(created.options.webPreferences?.partition).not.toContain("persist:");
      expect(created.options.webPreferences).not.toHaveProperty("preload");
      expect(created.show).toHaveBeenCalledOnce();
      expect(created.destroy).toHaveBeenCalledOnce();
      expect(created.clearStorageData).toHaveBeenCalledOnce();
      expect(created.clearCache).toHaveBeenCalledOnce();
      expect(created.closeAllConnections).toHaveBeenCalledOnce();
    });
    v1Case("browser-workspace-94557ef32ede", () => {
      expect(created.destroy).toHaveBeenCalledOnce();
      expect(created.clearStorageData).toHaveBeenCalledOnce();
      expect(created.closeAllConnections).toHaveBeenCalledOnce();
    });
  });

  it("reports a user-closed Electron window to the Rust cancellation state", async () => {
    let window: FakeCompatibilityWindow | undefined;
    const { manager, invoke } = createManager({
      createWindow: (options) => {
        window = new FakeCompatibilityWindow(options);
        return window.asBrowserWindow();
      }
    });
    await manager.executeEffect(effect({
      type: "compatibilityCreateWindow",
      plan: {
        gameId: "game-1",
        gameName: "Example",
        launchUrl: "https://example.test/play",
        startedAt: "2026-07-15T00:00:00.000Z"
      }
    }));

    window!.close();

    expect(invoke).toHaveBeenCalledWith({
      type: "compatibilityCancel",
      gameId: "game-1"
    });
  });

  it("projects Rust statuses and delegates report staleness unchanged", async () => {
    let listener: ((events: CoreEvent[]) => void) | undefined;
    const invoke = vi.fn(async (command: { type: string }) =>
      command.type === "compatibilityStatuses" ? [] : [{ ...report, isStale: true }]
    );
    const { manager } = createManager({
      invoke,
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      }
    });
    listener?.([{
      type: "compatibilityStatuses",
      statuses: [{
        gameId: "game-1",
        phase: "probing",
        startedAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:01.000Z"
      }]
    }]);

    expect(manager.listStatuses()).toMatchObject([{ gameId: "game-1", phase: "probing" }]);
    await expect(manager.listReports()).resolves.toMatchObject([{ isStale: true }]);
  });
});

function createManager(options: {
  applyCdnCompatibility?: (session: Session) => Promise<void>;
  applyProxy?: (session: Session) => Promise<void>;
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  invoke?: ReturnType<typeof vi.fn>;
  subscribe?: (listener: (events: CoreEvent[]) => void) => () => void;
} = {}) {
  const invoke = options.invoke ?? vi.fn(async (command: { type: string }) =>
    command.type === "compatibilityStatuses" ? [] : report
  );
  const manager = new GameCompatibilityManager({
    applyCdnCompatibility: options.applyCdnCompatibility ?? (async () => undefined),
    applyProxy: options.applyProxy ?? (async () => undefined),
    core: {
      invoke,
      subscribe: options.subscribe ?? (() => () => undefined)
    } as never,
    createWindow: options.createWindow
      ?? ((windowOptions) => new FakeCompatibilityWindow(windowOptions).asBrowserWindow()),
    getLaunchWorkArea: () => ({ x: 100, y: 50, width: 1000, height: 700 }),
    versions: { chrome: "140.0.0", electron: "40.0.0" } as NodeJS.ProcessVersions
  });
  return { invoke, manager };
}

function effect<T extends CompatibilityCoreEffectAction>(action: T) {
  return {
    effectId: "effect-1",
    operationId: "operation-1",
    target: { kind: "app" as const, handleId: "game-1" },
    deadlineMs: 100,
    action
  };
}

class FakeCompatibilityWindow extends EventEmitter {
  readonly clearCache = vi.fn(async () => undefined);
  readonly clearStorageData = vi.fn(async () => undefined);
  readonly closeAllConnections = vi.fn(async () => undefined);
  readonly show = vi.fn();
  readonly options: BrowserWindowConstructorOptions;
  private destroyed = false;

  readonly destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit("closed");
  });

  readonly webContents = {
    executeJavaScript: vi.fn(async () => ({
      webgl: "available",
      webgl2: "available",
      webgpu: "unavailable"
    })),
    getURL: vi.fn(() => "https://example.test/play?token=private"),
    loadURL: vi.fn(async () => undefined),
    session: {
      clearCache: this.clearCache,
      clearStorageData: this.clearStorageData,
      closeAllConnections: this.closeAllConnections
    },
    setWindowOpenHandler: vi.fn()
  };

  constructor(options: BrowserWindowConstructorOptions) {
    super();
    this.options = options;
  }

  close(): void {
    this.destroyed = true;
    this.emit("closed");
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  asBrowserWindow(): BrowserWindow {
    return this as unknown as BrowserWindow;
  }
}
