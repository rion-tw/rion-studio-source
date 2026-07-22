import { EventEmitter } from "node:events";

import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { CoreCommand, CoreEvent } from "../src/shared/generated";
import type { Game, GameCompatibilityReport } from "../src/shared/types";
import { GameCompatibilityManager } from "../src/main/games/GameCompatibilityManager";

const game: Game = {
  id: "game-1",
  source: "custom",
  name: "Example",
  defaultLaunchUrl: "https://example.test/play",
  browserLaunchMode: "inherit",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z"
};

describe("GameCompatibilityManager", () => {
  it("uses a visible non-persistent sandbox window and cleans its session after a successful probe", async () => {
    const windows: FakeCompatibilityWindow[] = [];
    const { manager, applyCdnCompatibility, applyProxy } = createManager({
      createWindow: (options) => {
        const window = new FakeCompatibilityWindow(options);
        windows.push(window);
        return window.asBrowserWindow();
      }
    });

    const report = await manager.runCheck(game.id);

    expect(report).toMatchObject({
      gameId: game.id,
      load: { state: "available", finalOrigin: "https://example.test" },
      graphics: { webgl: "available", webgl2: "available", webgpu: "unavailable" },
      recommendation: { reason: "embedded_available" },
      systemChrome: { state: "available" }
    });
    const created = windows[0];
    expect(created.options.show).toBe(false);
    expect(created.options).toMatchObject({ x: 100, y: 50, width: 1000, height: 700 });
    expect(created.options.webPreferences).toMatchObject({
      backgroundThrottling: true,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    });
    expect(created.options.webPreferences?.partition).toMatch(/^rion-compatibility-/);
    expect(created.options.webPreferences?.partition).not.toContain("persist:");
    expect(created.options.webPreferences).not.toHaveProperty("preload");
    expect(created.show).toHaveBeenCalledOnce();
    expect(created.webContents.loadURL).toHaveBeenCalledWith(game.defaultLaunchUrl);
    expect(created.destroy).toHaveBeenCalledOnce();
    expect(created.clearStorageData).toHaveBeenCalledOnce();
    expect(created.clearCache).toHaveBeenCalledOnce();
    expect(created.closeAllConnections).toHaveBeenCalledOnce();
    expect(applyProxy).toHaveBeenCalledOnce();
    expect(applyCdnCompatibility).toHaveBeenCalledOnce();
    expect(manager.listStatuses()).toEqual([]);
  });

  it("recommends external Chrome after an embedded load failure", async () => {
    const { manager } = createManager({
      createWindow: (options) => new FakeCompatibilityWindow(options, "fail").asBrowserWindow()
    });

    await expect(manager.runCheck(game.id)).resolves.toMatchObject({
      load: { state: "failed", errorCode: "ERR_CONNECTION_REFUSED" },
      recommendation: { mode: "external", reason: "external_recommended" }
    });
  });

  it("reports the Chrome blocker when embedded loading fails without Chrome", async () => {
    const { manager } = createManager({
      chromeAvailable: false,
      createWindow: (options) => new FakeCompatibilityWindow(options, "fail").asBrowserWindow()
    });

    await expect(manager.runCheck(game.id)).resolves.toMatchObject({
      systemChrome: { state: "unavailable" },
      recommendation: { reason: "chrome_required" }
    });
  });

  it("degrades safely when one cleanup operation fails", async () => {
    const { manager } = createManager({
      createWindow: (options) => {
        const window = new FakeCompatibilityWindow(options);
        window.clearCache.mockRejectedValueOnce(new Error("cleanup failed"));
        return window.asBrowserWindow();
      }
    });

    await expect(manager.runCheck(game.id)).resolves.toMatchObject({ load: { state: "available" } });
  });

  it("times out, prevents duplicate checks, and allows the user to cancel by closing the window", async () => {
    let activeWindow: FakeCompatibilityWindow | undefined;
    const { manager } = createManager({
      loadTimeoutMs: 5,
      createWindow: (options) => {
        activeWindow = new FakeCompatibilityWindow(options, "pending");
        return activeWindow.asBrowserWindow();
      }
    });
    const timedRun = manager.runCheck(game.id);
    await expect(manager.runCheck(game.id)).rejects.toThrow("already running");
    await expect(timedRun).resolves.toMatchObject({
      load: { state: "failed", errorCode: "COMPATIBILITY_LOAD_TIMEOUT" }
    });

    activeWindow = undefined;
    const cancelledRun = manager.runCheck(game.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(activeWindow).toBeDefined();
    const userClosedWindow = activeWindow as FakeCompatibilityWindow | undefined;
    userClosedWindow?.close();
    await expect(cancelledRun).resolves.toMatchObject({ load: { state: "cancelled" } });

    activeWindow = undefined;
    const cancelledByApi = manager.runCheck(game.id);
    await Promise.resolve();
    await Promise.resolve();
    await manager.cancelCheck(game.id);
    await expect(cancelledByApi).resolves.toMatchObject({ load: { state: "cancelled" } });
  });

  it("uses Rust as the source of truth for current report staleness", async () => {
    const { manager, core } = createManager({
      createWindow: (options) => new FakeCompatibilityWindow(options).asBrowserWindow()
    });
    await manager.runCheck(game.id);
    core.reports[0]!.isStale = true;
    await expect(manager.listReports()).resolves.toMatchObject([{ isStale: true }]);
  });
});

function createManager({
  chromeAvailable = true,
  createWindow,
  loadTimeoutMs = 20_000
}: {
  chromeAvailable?: boolean;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  loadTimeoutMs?: number;
}) {
  const applyCdnCompatibility = vi.fn(async (_session: Session) => undefined);
  const applyProxy = vi.fn(async (_session: Session) => undefined);
  const core = new FakeCompatibilityCore();
  const manager = new GameCompatibilityManager({
    applyCdnCompatibility,
    applyProxy,
    core,
    createWindow,
    getLaunchWorkArea: () => ({ x: 100, y: 50, width: 1000, height: 700 }),
    isSystemChromeAvailable: () => chromeAvailable,
    loadTimeoutMs,
    versions: { chrome: "140.0.0", electron: "40.0.0" } as NodeJS.ProcessVersions
  });
  return { manager, applyCdnCompatibility, applyProxy, core };
}

class FakeCompatibilityCore {
  readonly reports: GameCompatibilityReport[] = [];
  private readonly listeners = new Set<(events: CoreEvent[]) => void>();
  private active = false;
  private cancelled = false;
  private phase: "preparing" | "loading" | "probing" | "cleaning_up" = "preparing";
  private systemChromeAvailable = true;

  subscribe(listener: (events: CoreEvent[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async invoke<T>(command: CoreCommand): Promise<T> {
    if (command.type === "compatibilityStatuses") {
      return this.statuses() as T;
    }
    if (command.type === "compatibilityPrepare") {
      if (this.active) throw new Error("A compatibility check is already running for this game.");
      this.active = true;
      this.cancelled = false;
      this.phase = "preparing";
      this.systemChromeAvailable = command.systemChromeAvailable;
      this.emitStatuses();
      return {
        gameId: game.id,
        gameName: game.name,
        launchUrl: game.defaultLaunchUrl,
        startedAt: "2026-07-15T00:00:00.000Z"
      } as T;
    }
    if (command.type === "compatibilityTransition") {
      this.phase = command.phase;
      this.emitStatuses();
      return { updated: true } as T;
    }
    if (command.type === "compatibilityCancel") {
      this.cancelled = this.active;
      return { requested: this.active } as T;
    }
    if (command.type === "compatibilityComplete") {
      const outcome = command.outcome;
      const cancelled = this.cancelled || outcome.kind === "cancelled";
      const load = cancelled
        ? { state: "cancelled" as const, durationMs: outcome.durationMs }
        : outcome.kind === "loaded"
          ? {
              state: "available" as const,
              durationMs: outcome.durationMs,
              ...(outcome.finalOrigin ? { finalOrigin: outcome.finalOrigin } : {})
            }
          : { state: "failed" as const, durationMs: outcome.durationMs, errorCode: outcome.errorCode };
      const report: GameCompatibilityReport = {
        gameId: game.id,
        checkedAt: "2026-07-15T00:00:01.000Z",
        configurationFingerprint: "rust-fingerprint",
        isStale: false,
        load,
        ...(!cancelled && outcome.kind === "loaded" ? { graphics: outcome.graphics } : {}),
        systemChrome: { state: this.systemChromeAvailable ? "available" : "unavailable" },
        ...(!cancelled
          ? outcome.kind === "loaded"
            ? { recommendation: { reason: outcome.graphics.webgl === "available" ? "embedded_available" as const : "graphics_unavailable" as const } }
            : {
                recommendation: this.systemChromeAvailable
                  ? { mode: "external" as const, reason: "external_recommended" as const }
                  : { reason: "chrome_required" as const }
              }
          : {}),
        observations: {}
      };
      this.reports.splice(0, this.reports.length, report);
      this.active = false;
      this.emitStatuses();
      return structuredClone(report) as T;
    }
    if (command.type === "compatibilityReportsCurrent") {
      return structuredClone(this.reports) as T;
    }
    if (command.type === "compatibilityReportDelete") {
      this.reports.splice(0);
      return { deleted: true } as T;
    }
    if (command.type === "compatibilityReportRecordObservation") {
      return {} as T;
    }
    throw new Error(`Unsupported command in compatibility test: ${command.type}`);
  }

  private statuses() {
    return this.active ? [{
      gameId: game.id,
      phase: this.phase,
      startedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    }] : [];
  }

  private emitStatuses(): void {
    const events: CoreEvent[] = [{ type: "compatibilityStatuses", statuses: this.statuses() }];
    for (const listener of this.listeners) listener(events);
  }
}

class FakeCompatibilityWindow extends EventEmitter {
  readonly clearCache = vi.fn(async () => undefined);
  readonly clearStorageData = vi.fn(async () => undefined);
  readonly closeAllConnections = vi.fn(async () => undefined);
  readonly destroy = vi.fn(() => { this.destroyed = true; });
  readonly show = vi.fn();
  readonly options: BrowserWindowConstructorOptions;
  private destroyed = false;
  private readonly loadBehavior: "success" | "fail" | "pending";

  readonly webContents = {
    executeJavaScript: vi.fn(async () => ({
      webgl: "available",
      webgl2: "available",
      webgpu: "unavailable",
      renderer: "Test GPU",
      vendor: "Test Vendor"
    })),
    getURL: vi.fn(() => "https://example.test/play?token=private"),
    loadURL: vi.fn(async (_url: string) => {
      if (this.loadBehavior === "fail") {
        throw Object.assign(new Error("refused"), { code: "ERR_CONNECTION_REFUSED" });
      }
      if (this.loadBehavior === "pending") {
        await new Promise<void>(() => undefined);
      }
    }),
    session: {
      clearCache: this.clearCache,
      clearStorageData: this.clearStorageData,
      closeAllConnections: this.closeAllConnections
    },
    setWindowOpenHandler: vi.fn()
  };

  constructor(options: BrowserWindowConstructorOptions, loadBehavior: "success" | "fail" | "pending" = "success") {
    super();
    this.options = options;
    this.loadBehavior = loadBehavior;
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
