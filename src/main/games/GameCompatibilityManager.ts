import { EventEmitter } from "node:events";

import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from "electron";

import type {
  CompatibilityCheckOutcome,
  CompatibilityCheckPlanRecord,
  CompatibilityRunStatusRecord,
  CompatibilityVersionRecord
} from "../../shared/generated";
import type {
  GameCompatibilityObservations,
  GameCompatibilityReport,
  GameCompatibilityRunPhase,
  GameCompatibilityRunStatus,
  PixelBounds
} from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";
import { probeWebGraphics } from "../game-browser/GraphicsDiagnosticsService";

const LOAD_TIMEOUT_MS = 20_000;

export interface GameCompatibilityManagerEvents {
  change: [];
}

interface GameCompatibilityManagerOptions {
  applyCdnCompatibility: (session: Session) => Promise<void>;
  applyProxy: (session: Session) => Promise<void>;
  core: Pick<AppCoreClient, "invoke" | "subscribe">;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  getLaunchWorkArea: () => PixelBounds;
  isSystemChromeAvailable: () => boolean;
  loadTimeoutMs?: number;
  versions?: NodeJS.ProcessVersions;
}

/** Electron effect executor for the Rust-owned compatibility runtime. */
export class GameCompatibilityManager extends EventEmitter<GameCompatibilityManagerEvents> {
  private readonly windows = new Map<string, BrowserWindow>();
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
    void options.core.invoke<CompatibilityRunStatusRecord[]>({ type: "compatibilityStatuses" })
      .then((statuses) => {
        this.statusProjection = structuredClone(statuses);
      })
      .catch(() => undefined);
  }

  listStatuses(): GameCompatibilityRunStatus[] {
    return structuredClone(this.statusProjection);
  }

  listReports(): Promise<GameCompatibilityReport[]> {
    return this.options.core.invoke<GameCompatibilityReport[]>({
      type: "compatibilityReportsCurrent",
      versions: this.versions()
    });
  }

  async runCheck(gameId: string): Promise<GameCompatibilityReport> {
    const plan = await this.options.core.invoke<CompatibilityCheckPlanRecord>({
      type: "compatibilityPrepare",
      gameId,
      systemChromeAvailable: this.options.isSystemChromeAvailable(),
      versions: this.versions()
    });
    const startedAtMs = Date.now();
    let window: BrowserWindow | undefined;
    let closed = false;
    let outcome: CompatibilityCheckOutcome;

    try {
      window = this.createTestWindow(plan);
      this.windows.set(gameId, window);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const closedPromise = new Promise<"closed">((resolve) => window!.once("closed", () => {
        closed = true;
        resolve("closed");
      }));
      await Promise.all([
        this.options.applyProxy(window.webContents.session),
        this.options.applyCdnCompatibility(window.webContents.session)
      ]);

      if (closed) {
        await this.requestCancel(gameId);
        outcome = { kind: "cancelled", durationMs: Date.now() - startedAtMs };
      } else {
        window.show();
        await this.transition(gameId, "loading");
        const timeout = createTimeout(this.options.loadTimeoutMs ?? LOAD_TIMEOUT_MS);
        let loadResult: "loaded" | "closed" | "timeout";
        try {
          loadResult = await Promise.race([
            window.webContents.loadURL(plan.launchUrl).then(() => "loaded" as const),
            closedPromise,
            timeout.promise
          ]);
        } finally {
          timeout.cancel();
        }

        if (loadResult === "closed" || closed) {
          await this.requestCancel(gameId);
          outcome = { kind: "cancelled", durationMs: Date.now() - startedAtMs };
        } else if (loadResult === "timeout") {
          outcome = {
            kind: "failed",
            durationMs: Date.now() - startedAtMs,
            errorCode: "COMPATIBILITY_LOAD_TIMEOUT"
          };
        } else {
          const finalOrigin = readOrigin(window.webContents.getURL());
          await this.transition(gameId, "probing");
          const graphics = await probeWebGraphics(
            (source) => window!.webContents.executeJavaScript(source)
          );
          if (closed) {
            await this.requestCancel(gameId);
            outcome = { kind: "cancelled", durationMs: Date.now() - startedAtMs };
          } else {
            outcome = {
              kind: "loaded",
              durationMs: Date.now() - startedAtMs,
              ...(finalOrigin ? { finalOrigin } : {}),
              graphics
            };
          }
        }
      }
    } catch (error) {
      if (closed) {
        await this.requestCancel(gameId);
        outcome = { kind: "cancelled", durationMs: Date.now() - startedAtMs };
      } else {
        outcome = {
          kind: "failed",
          durationMs: Date.now() - startedAtMs,
          errorCode: toErrorCode(error)
        };
      }
    } finally {
      await this.transition(gameId, "cleaning_up").catch(() => undefined);
      await cleanupWindow(window);
      this.windows.delete(gameId);
    }

    return this.options.core.invoke<GameCompatibilityReport>({
      type: "compatibilityComplete",
      gameId,
      outcome
    });
  }

  async cancelCheck(gameId: string): Promise<void> {
    await this.requestCancel(gameId);
    const window = this.windows.get(gameId);
    if (window && !window.isDestroyed()) window.close();
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

  private createTestWindow(plan: CompatibilityCheckPlanRecord): BrowserWindow {
    const workArea = this.options.getLaunchWorkArea();
    const partitionSuffix = plan.startedAt.replace(/[^0-9A-Za-z]/g, "");
    return this.options.createWindow({
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
  }

  private transition(gameId: string, phase: GameCompatibilityRunPhase): Promise<unknown> {
    return this.options.core.invoke({ type: "compatibilityTransition", gameId, phase });
  }

  private requestCancel(gameId: string): Promise<unknown> {
    return this.options.core.invoke({ type: "compatibilityCancel", gameId });
  }

  private versions(): CompatibilityVersionRecord {
    return {
      chrome: this.options.versions?.chrome ?? process.versions.chrome ?? "unknown",
      electron: this.options.versions?.electron ?? process.versions.electron ?? "unknown"
    };
  }
}

async function cleanupWindow(window: BrowserWindow | undefined): Promise<void> {
  if (!window) return;
  const session = window.webContents.session;
  if (!window.isDestroyed()) window.destroy();
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
      if (timer) clearTimeout(timer);
      timer = undefined;
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
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return "COMPATIBILITY_LOAD_FAILED";
}
