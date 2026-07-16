import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from "electron";

import { probeWebGraphics } from "../game-browser/GraphicsDiagnosticsService";
import type { GameBrowserSettingsStore } from "../game-browser/GameBrowserSettingsStore";
import type { GameStore } from "./GameStore";
import type { GameCompatibilityStore } from "./GameCompatibilityStore";
import type {
  Game,
  GameCompatibilityObservations,
  GameCompatibilityReport,
  GameCompatibilityRunPhase,
  GameCompatibilityRunStatus,
  GameBrowserSettings,
  PixelBounds,
  RoleDefaults
} from "../../shared/types";

const LOAD_TIMEOUT_MS = 20_000;

interface ActiveCheck {
  cancelled: boolean;
  window?: BrowserWindow;
}

export interface GameCompatibilityManagerEvents {
  change: [];
}

interface GameCompatibilityManagerOptions {
  applyCdnCompatibility: (session: Session) => Promise<void>;
  applyProxy: (session: Session) => Promise<void>;
  compatibilityStore: Pick<
    GameCompatibilityStore,
    "deleteGame" | "listReports" | "recordObservation" | "saveReport"
  >;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  gameBrowserSettingsStore: Pick<GameBrowserSettingsStore, "getSettings">;
  gameStore: Pick<GameStore, "getGame" | "listGames">;
  getLaunchWorkArea: () => PixelBounds;
  isSystemChromeAvailable: () => boolean;
  loadTimeoutMs?: number;
  versions?: NodeJS.ProcessVersions;
}

export class GameCompatibilityManager extends EventEmitter<GameCompatibilityManagerEvents> {
  private readonly activeChecks = new Map<string, ActiveCheck>();
  private readonly statuses = new Map<string, GameCompatibilityRunStatus>();

  constructor(private readonly options: GameCompatibilityManagerOptions) {
    super();
  }

  listStatuses(): GameCompatibilityRunStatus[] {
    return structuredClone([...this.statuses.values()]);
  }

  async listReports(): Promise<GameCompatibilityReport[]> {
    const [reports, games, settings] = await Promise.all([
      this.options.compatibilityStore.listReports(),
      this.options.gameStore.listGames(),
      this.options.gameBrowserSettingsStore.getSettings()
    ]);
    const gameById = new Map(games.map((game) => [game.id, game]));
    return reports.flatMap((report) => {
      const game = gameById.get(report.gameId);
      if (!game) {
        return [];
      }
      return [{
        ...report,
        isStale: Boolean(
          report.configurationFingerprint &&
          report.configurationFingerprint !== createConfigurationFingerprint(game, settings, this.options.versions)
        )
      }];
    });
  }

  async runCheck(gameId: string, fallbackRoleDefaults: RoleDefaults): Promise<GameCompatibilityReport> {
    if (this.activeChecks.has(gameId)) {
      throw new Error("A compatibility check is already running for this game.");
    }

    const active: ActiveCheck = { cancelled: false };
    this.activeChecks.set(gameId, active);
    this.setStatus(gameId, "preparing");
    let game: Game;
    let settings: GameBrowserSettings;
    try {
      [game, settings] = await Promise.all([
        this.options.gameStore.getGame(gameId),
        this.options.gameBrowserSettingsStore.getSettings()
      ]);
    } catch (error) {
      this.activeChecks.delete(gameId);
      this.statuses.delete(gameId);
      this.emit("change");
      throw error;
    }
    const startedAt = Date.now();
    const chromeAvailable = this.options.isSystemChromeAvailable();
    let report: GameCompatibilityReport;

    try {
      const window = this.createTestWindow(game, fallbackRoleDefaults);
      active.window = window;
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const closedPromise = new Promise<"closed">((resolve) => window.once("closed", () => {
        active.cancelled = true;
        resolve("closed");
      }));
      await Promise.all([
        this.options.applyProxy(window.webContents.session),
        this.options.applyCdnCompatibility(window.webContents.session)
      ]);

      if (active.cancelled) {
        throw new CompatibilityCancelledError();
      }

      window.show();
      this.setStatus(gameId, "loading");
      const timeout = createTimeout(this.options.loadTimeoutMs ?? LOAD_TIMEOUT_MS);
      let loadResult: "loaded" | "closed" | "timeout";
      try {
        loadResult = await Promise.race([
          window.webContents.loadURL(game.defaultLaunchUrl).then(() => "loaded" as const),
          closedPromise,
          timeout.promise
        ]);
      } finally {
        timeout.cancel();
      }

      if (loadResult === "closed" || active.cancelled) {
        throw new CompatibilityCancelledError();
      }
      if (loadResult === "timeout") {
        throw new CompatibilityLoadError("COMPATIBILITY_LOAD_TIMEOUT");
      }

      const finalOrigin = readOrigin(window.webContents.getURL());
      this.setStatus(gameId, "probing");
      const graphics = await probeWebGraphics((source) => window.webContents.executeJavaScript(source));
      if (active.cancelled) {
        throw new CompatibilityCancelledError();
      }
      report = {
        gameId,
        checkedAt: new Date().toISOString(),
        configurationFingerprint: createConfigurationFingerprint(game, settings, this.options.versions),
        isStale: false,
        load: {
          state: "available",
          durationMs: Date.now() - startedAt,
          ...(finalOrigin ? { finalOrigin } : {})
        },
        graphics,
        systemChrome: { state: chromeAvailable ? "available" : "unavailable" },
        recommendation: graphics.webgl === "available"
          ? { reason: "embedded_available" }
          : { reason: "graphics_unavailable" },
        observations: {}
      };
    } catch (error) {
      const cancelled = error instanceof CompatibilityCancelledError || active.cancelled;
      const errorCode = cancelled ? undefined : toErrorCode(error);
      report = {
        gameId,
        checkedAt: new Date().toISOString(),
        configurationFingerprint: createConfigurationFingerprint(game, settings, this.options.versions),
        isStale: false,
        load: {
          state: cancelled ? "cancelled" : "failed",
          durationMs: Date.now() - startedAt,
          ...(errorCode ? { errorCode } : {})
        },
        systemChrome: { state: chromeAvailable ? "available" : "unavailable" },
        ...(!cancelled
          ? {
              recommendation: chromeAvailable
                ? { mode: "external" as const, reason: "external_recommended" as const }
                : { reason: "chrome_required" as const }
            }
          : {}),
        observations: {}
      };
    } finally {
      this.setStatus(gameId, "cleaning_up");
      await cleanupWindow(active.window);
      this.activeChecks.delete(gameId);
      this.statuses.delete(gameId);
    }

    const saved = await this.options.compatibilityStore.saveReport(report);
    this.emit("change");
    return saved;
  }

  async cancelCheck(gameId: string): Promise<void> {
    const active = this.activeChecks.get(gameId);
    if (!active) {
      return;
    }
    active.cancelled = true;
    if (active.window && !active.window.isDestroyed()) {
      active.window.close();
    }
  }

  async recordObservation(
    gameId: string,
    observation: Partial<GameCompatibilityObservations>
  ): Promise<void> {
    await this.options.compatibilityStore.recordObservation(gameId, observation);
    this.emit("change");
  }

  async deleteGame(gameId: string): Promise<void> {
    await this.cancelCheck(gameId);
    await this.options.compatibilityStore.deleteGame(gameId);
    this.emit("change");
  }

  private createTestWindow(game: Game, fallbackRoleDefaults: RoleDefaults): BrowserWindow {
    const workArea = this.options.getLaunchWorkArea();
    const defaults = game.roleDefaults ?? fallbackRoleDefaults;
    const width = Math.min(Math.max(defaults.windowWidth, 640), workArea.width);
    const height = Math.min(Math.max(defaults.windowHeight, 640), workArea.height);
    return this.options.createWindow({
      x: workArea.x + Math.floor((workArea.width - width) / 2),
      y: workArea.y + Math.floor((workArea.height - height) / 2),
      width,
      height,
      title: `Rion Studio - Compatibility Check - ${game.name}`,
      show: false,
      backgroundColor: "#000000",
      webPreferences: {
        partition: `rion-compatibility-${randomUUID()}`,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: true,
        spellcheck: false,
        webgl: true
      }
    });
  }

  private setStatus(gameId: string, phase: GameCompatibilityRunPhase): void {
    const current = this.statuses.get(gameId);
    const now = new Date().toISOString();
    this.statuses.set(gameId, {
      gameId,
      phase,
      startedAt: current?.startedAt ?? now,
      updatedAt: now
    });
    this.emit("change");
  }
}

class CompatibilityCancelledError extends Error {}

class CompatibilityLoadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function createConfigurationFingerprint(
  game: Game,
  settings: GameBrowserSettings,
  versions: NodeJS.ProcessVersions = process.versions
): string {
  const input = JSON.stringify({
    defaultLaunchUrl: game.defaultLaunchUrl,
    loginUrl: game.loginUrl ?? "",
    network: settings.network,
    graphics: settings.graphics,
    chrome: versions.chrome ?? "unknown",
    electron: versions.electron ?? "unknown"
  });
  return createHash("sha256").update(input).digest("hex");
}

async function cleanupWindow(window: BrowserWindow | undefined): Promise<void> {
  if (!window) {
    return;
  }
  const session = window.webContents.session;
  if (!window.isDestroyed()) {
    window.destroy();
  }
  await Promise.allSettled([
    session.clearStorageData(),
    session.clearCache(),
    session.closeAllConnections()
  ]);
}

function createTimeout(timeoutMs: number): { cancel: () => void; promise: Promise<"timeout"> } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  return {
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    promise
  };
}

function readOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function toErrorCode(error: unknown): string {
  if (error instanceof CompatibilityLoadError) {
    return error.code;
  }
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return "COMPATIBILITY_LOAD_FAILED";
}
