import { EventEmitter } from "node:events";

import type { BaseWindow, BaseWindowConstructorOptions } from "electron";

import type { CompatibilityCoreEffectAction } from "../core/ElectronEffectExecutor";
import type {
  CoreEffectRequest,
  CoreJsonValue,
  RuntimeVersionRecord
} from "../../shared/generated";
import type {
  GameCompatibilityObservations,
  GameCompatibilityReport,
  GameCompatibilityRunStatus,
  PixelBounds
} from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";
import type { NativeRoleSurfaceConfiguration } from "../browser/SystemWebViewRuntimePool";
import type {
  SystemCompatibilitySurfaceFactory
} from "../browser/SystemCompatibilitySurfaceFactory";
import type { WebSurfaceLifecycleEvent, WebSurfacePort } from "../browser/ports/WebSurfacePort";

export interface GameCompatibilityManagerEvents {
  change: [];
}

interface GameCompatibilityManagerOptions {
  core: Pick<AppCoreClient, "invoke" | "subscribe">;
  createSurface: SystemCompatibilitySurfaceFactory;
  createWindow: (options: BaseWindowConstructorOptions) => BaseWindow;
  getLaunchWorkArea: () => PixelBounds;
  getSessionConfiguration: () => Promise<NativeRoleSurfaceConfiguration>;
  getVersions: () => Promise<RuntimeVersionRecord>;
}

interface CompatibilitySurfaceHandle {
  cleanup?: () => Promise<void>;
  closedListener: () => void;
  finalUrl?: string;
  surface: WebSurfacePort;
  unsubscribe: () => void;
  window: BaseWindow;
}

export type CompatibilityCoreEffect = CoreEffectRequest & {
  action: CompatibilityCoreEffectAction;
};

/** Executes compatibility checks in the same OS WebView engine used by game roles. */
export class GameCompatibilityManager extends EventEmitter<GameCompatibilityManagerEvents> {
  private readonly surfaces = new Map<string, CompatibilitySurfaceHandle>();
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

  async listReports(): Promise<GameCompatibilityReport[]> {
    return this.options.core.invoke({
      type: "compatibilityReportsCurrent",
      versions: await this.options.getVersions()
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
      versions: await this.options.getVersions()
    });
  }

  async cancelCheck(gameId: string): Promise<void> {
    await this.options.core.invoke({ type: "compatibilityCancel", gameId });
  }

  async executeEffect(effect: CompatibilityCoreEffect): Promise<CoreJsonValue | undefined> {
    switch (effect.action.type) {
      case "compatibilityCreateWindow":
        await this.createTestSurface(effect.action.plan);
        return undefined;
      case "compatibilityConfigureSession": {
        const handle = this.requireSurface(effect.action.gameId);
        const area = this.options.getLaunchWorkArea();
        await handle.surface.setBounds({ x: 0, y: 0, width: area.width, height: area.height });
        await handle.surface.setVisible(true);
        if (handle.window.isDestroyed()) throw effectError("COMPATIBILITY_WINDOW_CLOSED");
        handle.window.show();
        return undefined;
      }
      case "compatibilityLoadUrl": {
        const handle = this.requireSurface(effect.action.gameId);
        await handle.surface.loadUrl(effect.action.url);
        return { finalUrl: handle.finalUrl ?? effect.action.url };
      }
      case "compatibilityProbeGraphics":
        return await this.requireSurface(effect.action.gameId)
          .surface.evaluate<CoreJsonValue>(effect.action.source);
      case "compatibilityCleanupWindow":
        await this.cleanupSurface(effect.action.gameId);
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

  private async createTestSurface(plan: {
    gameId: string;
    gameName: string;
    startedAt: string;
  }): Promise<void> {
    if (this.surfaces.has(plan.gameId)) {
      throw effectError("COMPATIBILITY_RUN_ALREADY_ACTIVE");
    }
    const workArea = this.options.getLaunchWorkArea();
    const window = this.options.createWindow({
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height,
      title: `Rion Studio - Compatibility Check - ${plan.gameName}`,
      show: false,
      backgroundColor: "#000000"
    });
    try {
      const runId = `${plan.gameId}-${plan.startedAt.replace(/[^0-9A-Za-z]/g, "")}`;
      const configuration = await this.options.getSessionConfiguration();
      const created = this.options.createSurface(
        window,
        runId,
        configuration
      );
      if (configuration.documentStartScript) {
        await created.surface.addDocumentStartScript(configuration.documentStartScript);
      }
      const handle: CompatibilitySurfaceHandle = {
        ...created,
        closedListener: () => this.handleUnexpectedClose(plan.gameId),
        unsubscribe: () => undefined,
        window
      };
      handle.unsubscribe = created.surface.onLifecycleEvent((event) => {
        this.handleLifecycleEvent(plan.gameId, event);
      });
      window.once("closed", handle.closedListener);
      this.surfaces.set(plan.gameId, handle);
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  private requireSurface(gameId: string): CompatibilitySurfaceHandle {
    const handle = this.surfaces.get(gameId);
    if (!handle || handle.window.isDestroyed()) {
      throw effectError("COMPATIBILITY_WINDOW_CLOSED");
    }
    return handle;
  }

  private handleLifecycleEvent(gameId: string, event: WebSurfaceLifecycleEvent): void {
    const handle = this.surfaces.get(gameId);
    if (!handle) return;
    if (event.type === "navigationCompleted") {
      handle.finalUrl = event.url;
      return;
    }
    if (event.type === "crashed") {
      void this.cancelAndDispose(gameId);
    }
  }

  private handleUnexpectedClose(gameId: string): void {
    if (!this.surfaces.has(gameId)) return;
    void this.cancelAndDispose(gameId);
  }

  private async cancelAndDispose(gameId: string): Promise<void> {
    await Promise.allSettled([
      this.cancelCheck(gameId),
      this.cleanupSurface(gameId)
    ]);
  }

  private async cleanupSurface(gameId: string): Promise<void> {
    const handle = this.surfaces.get(gameId);
    if (!handle) return;
    this.surfaces.delete(gameId);
    handle.window.removeListener("closed", handle.closedListener);
    handle.unsubscribe();
    await handle.surface.clearStorage([
        "cookies",
        "localStorage",
        "indexedDB",
        "serviceWorkers",
        "cache"
      ]).catch(() => undefined);
    await handle.surface.destroy().catch(() => undefined);
    await handle.cleanup?.().catch(() => undefined);
    if (!handle.window.isDestroyed()) handle.window.destroy();
  }
}

function effectError(code: string): Error & { code: string } {
  return Object.assign(new Error("The compatibility System WebView was closed."), { code });
}
