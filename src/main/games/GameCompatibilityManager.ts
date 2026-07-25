import { EventEmitter } from "node:events";

import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from "electron";

import type { CompatibilityCoreEffectAction } from "../core/ElectronEffectExecutor";
import type {
  CompatibilityVersionRecord,
  CoreEffectRequest,
  CoreJsonValue
} from "../../shared/generated";
import type {
  GameCompatibilityObservations,
  GameCompatibilityReport,
  GameCompatibilityRunStatus,
  PixelBounds
} from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";

export interface GameCompatibilityManagerEvents {
  change: [];
}

interface GameCompatibilityManagerOptions {
  applyCdnCompatibility: (session: Session) => Promise<void>;
  applyProxy: (session: Session) => Promise<void>;
  core: Pick<AppCoreClient, "invoke" | "subscribe">;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  getLaunchWorkArea: () => PixelBounds;
  versions?: NodeJS.ProcessVersions;
}

interface CompatibilityWindowHandle {
  closedListener: () => void;
  session: Session;
  window: BrowserWindow;
}

export type CompatibilityCoreEffect = CoreEffectRequest & {
  action: CompatibilityCoreEffectAction;
};

/** Executes only BrowserWindow/session effects for the Rust compatibility actor. */
export class GameCompatibilityManager extends EventEmitter<GameCompatibilityManagerEvents> {
  private readonly windows = new Map<string, CompatibilityWindowHandle>();
  private statusProjection: GameCompatibilityRunStatus[] = [];

  constructor(private readonly options: GameCompatibilityManagerOptions) {
    super();
    options.core.subscribe((events) => {
      const event = [...events].reverse().find(
        (candidate) => candidate.type === "compatibilityStatuses"
      );
      if (event?.type !== "compatibilityStatuses") return;
      this.statusProjection = structuredClone(event.statuses);
      this.emit("change");
    });
    void options.core.invoke({ type: "compatibilityStatuses" })
      .then((statuses) => {
        this.statusProjection = structuredClone(statuses);
      })
      .catch(() => undefined);
  }

  listStatuses(): GameCompatibilityRunStatus[] {
    return structuredClone(this.statusProjection);
  }

  listReports(): Promise<GameCompatibilityReport[]> {
    return this.options.core.invoke({
      type: "compatibilityReportsCurrent",
      versions: this.versions()
    });
  }

  async runCheck(gameId: string): Promise<GameCompatibilityReport> {
    await this.options.core.invoke({
      type: "engineCompatibilityCacheDeleteGame",
      gameId
    });
    return this.options.core.invoke({
      type: "compatibilityRun",
      gameId,
      versions: this.versions()
    });
  }

  async cancelCheck(gameId: string): Promise<void> {
    await this.options.core.invoke({ type: "compatibilityCancel", gameId });
  }

  async executeEffect(effect: CompatibilityCoreEffect): Promise<CoreJsonValue | undefined> {
    switch (effect.action.type) {
      case "compatibilityCreateWindow":
        this.createTestWindow(effect.action.plan);
        return undefined;
      case "compatibilityConfigureSession": {
        const window = this.requireWindow(effect.action.gameId);
        await Promise.all([
          this.options.applyProxy(window.webContents.session),
          this.options.applyCdnCompatibility(window.webContents.session)
        ]);
        if (window.isDestroyed()) throw effectError("COMPATIBILITY_WINDOW_CLOSED");
        window.show();
        return undefined;
      }
      case "compatibilityLoadUrl": {
        const window = this.requireWindow(effect.action.gameId);
        await window.webContents.loadURL(effect.action.url);
        return { finalUrl: window.webContents.getURL() };
      }
      case "compatibilityProbeGraphics":
        return await this.requireWindow(effect.action.gameId)
          .webContents.executeJavaScript(effect.action.source) as CoreJsonValue;
      case "compatibilityCleanupWindow":
        await this.cleanupWindow(effect.action.gameId);
        return undefined;
    }
  }

  async recordObservation(
    gameId: string,
    observation: Partial<GameCompatibilityObservations>
  ): Promise<void> {
    await this.options.core.invoke({
      type: "compatibilityReportRecordObservation",
      gameId,
      observation
    });
    this.emit("change");
  }

  async deleteGame(gameId: string): Promise<void> {
    await this.cancelCheck(gameId);
    await this.options.core.invoke({ type: "compatibilityReportDelete", gameId });
    this.emit("change");
  }

  private createTestWindow(plan: {
    gameId: string;
    gameName: string;
    startedAt: string;
  }): void {
    const workArea = this.options.getLaunchWorkArea();
    const partitionSuffix = plan.startedAt.replace(/[^0-9A-Za-z]/g, "");
    const window = this.options.createWindow({
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height,
      title: `Rion Studio - Compatibility Check - ${plan.gameName}`,
      show: false,
      backgroundColor: "#000000",
      webPreferences: {
        partition: `rion-compatibility-${partitionSuffix}`,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: true,
        spellcheck: false,
        webgl: true
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const closedListener = (): void => {
      void this.options.core.invoke({ type: "compatibilityCancel", gameId: plan.gameId });
    };
    window.once("closed", closedListener);
    this.windows.set(plan.gameId, {
      closedListener,
      session: window.webContents.session,
      window
    });
  }

  private requireWindow(gameId: string): BrowserWindow {
    const window = this.windows.get(gameId)?.window;
    if (!window || window.isDestroyed()) throw effectError("COMPATIBILITY_WINDOW_CLOSED");
    return window;
  }

  private async cleanupWindow(gameId: string): Promise<void> {
    const handle = this.windows.get(gameId);
    if (!handle) return;
    this.windows.delete(gameId);
    const { closedListener, session, window } = handle;
    window.removeListener("closed", closedListener);
    if (!window.isDestroyed()) window.destroy();
    await Promise.allSettled([
      session.clearStorageData(),
      session.clearCache(),
      session.closeAllConnections()
    ]);
  }

  private versions(): CompatibilityVersionRecord {
    return {
      chrome: this.options.versions?.chrome ?? process.versions.chrome ?? "unknown",
      electron: this.options.versions?.electron ?? process.versions.electron ?? "unknown"
    };
  }
}

function effectError(code: string): Error & { code: string } {
  return Object.assign(new Error("The compatibility test window was closed."), { code });
}
