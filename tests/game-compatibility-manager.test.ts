import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import type { Game, GameBrowserSettings } from "../src/shared/types";
import { GameCompatibilityManager } from "../src/main/games/GameCompatibilityManager";
import { GameCompatibilityStore } from "../src/main/games/GameCompatibilityStore";

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
  let baseDir: string;
  let settings: GameBrowserSettings;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-compatibility-test-"));
    settings = structuredClone(DEFAULT_GAME_BROWSER_SETTINGS);
  });

  it("uses a visible non-persistent sandbox window and cleans its session after a successful probe", async () => {
    const windows: FakeCompatibilityWindow[] = [];
    const { manager, applyCdnCompatibility, applyProxy } = createManager({
      baseDir,
      settings: () => settings,
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
      baseDir,
      settings: () => settings,
      createWindow: (options) => new FakeCompatibilityWindow(options, "fail").asBrowserWindow()
    });

    await expect(manager.runCheck(game.id)).resolves.toMatchObject({
      load: { state: "failed", errorCode: "ERR_CONNECTION_REFUSED" },
      recommendation: { mode: "external", reason: "external_recommended" }
    });
  });

  it("reports the Chrome blocker when embedded loading fails without Chrome", async () => {
    const { manager } = createManager({
      baseDir,
      chromeAvailable: false,
      settings: () => settings,
      createWindow: (options) => new FakeCompatibilityWindow(options, "fail").asBrowserWindow()
    });

    await expect(manager.runCheck(game.id)).resolves.toMatchObject({
      systemChrome: { state: "unavailable" },
      recommendation: { reason: "chrome_required" }
    });
  });

  it("degrades safely when one cleanup operation fails", async () => {
    const { manager } = createManager({
      baseDir,
      settings: () => settings,
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
      baseDir,
      settings: () => settings,
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

  it("marks the saved report stale when network or graphics conditions change", async () => {
    const { manager } = createManager({
      baseDir,
      settings: () => settings,
      createWindow: (options) => new FakeCompatibilityWindow(options).asBrowserWindow()
    });
    await manager.runCheck(game.id);
    expect((await manager.listReports())[0].isStale).toBe(false);

    settings = {
      ...settings,
      graphics: { mode: "high_performance" }
    };
    expect((await manager.listReports())[0].isStale).toBe(true);
  });

  it("removes legacy login observations when compatibility data is read", async () => {
    const reportPath = join(baseDir, "game-compatibility.json");
    await writeFile(reportPath, JSON.stringify({ reports: [{
      gameId: game.id,
      isStale: false,
      observations: {
        lastAuthFailureAt: "2026-07-15T00:00:00.000Z",
        lastAuthSuccessAt: "2026-07-15T00:01:00.000Z",
        lastEmbeddedLaunchAt: "2026-07-15T00:02:00.000Z"
      }
    }] }), "utf8");

    const compatibilityStore = new GameCompatibilityStore(baseDir);
    await expect(compatibilityStore.listReports()).resolves.toMatchObject([{
      observations: { lastEmbeddedLaunchAt: "2026-07-15T00:02:00.000Z" }
    }]);
    const migrated = JSON.parse(await readFile(reportPath, "utf8")) as { reports: Array<{ observations: Record<string, unknown> }> };
    expect(migrated.reports[0].observations).not.toHaveProperty("lastAuthSuccessAt");
    expect(migrated.reports[0].observations).not.toHaveProperty("lastAuthFailureAt");
  });
});

function createManager({
  baseDir,
  chromeAvailable = true,
  createWindow,
  loadTimeoutMs = 20_000,
  settings
}: {
  baseDir: string;
  chromeAvailable?: boolean;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  loadTimeoutMs?: number;
  settings: () => GameBrowserSettings;
}) {
  const applyCdnCompatibility = vi.fn(async (_session: Session) => undefined);
  const applyProxy = vi.fn(async (_session: Session) => undefined);
  const manager = new GameCompatibilityManager({
    applyCdnCompatibility,
    applyProxy,
    compatibilityStore: new GameCompatibilityStore(baseDir),
    createWindow,
    gameBrowserSettingsStore: { getSettings: async () => settings() },
    gameStore: { getGame: async () => game, listGames: async () => [game] },
    getLaunchWorkArea: () => ({ x: 100, y: 50, width: 1000, height: 700 }),
    isSystemChromeAvailable: () => chromeAvailable,
    loadTimeoutMs,
    versions: { chrome: "140.0.0", electron: "40.0.0" } as NodeJS.ProcessVersions
  });
  return { manager, applyCdnCompatibility, applyProxy };
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
