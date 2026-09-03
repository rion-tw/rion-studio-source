import type {
  ChromeProfileImportProgressRecord,
  CoreEvent,
  LogEntry
} from "../../shared/generated";
import type { AppSnapshot } from "../../shared/types";
import { normalizeRionBridgeError } from "../ipc/errors";

function overlayRefreshWasSuperseded(error: unknown): boolean {
  const normalized = normalizeRionBridgeError(
    error,
    "ELECTRON_ROLE_OVERLAY_REFRESH_FAILED"
  );
  return normalized.code === "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED" ||
    normalized.code === "ELECTRON_ROLE_OVERLAY_SURFACE_RETIRED";
}

export interface ElectronCoreEventSource {
  subscribeCoreEvents: (listener: (event: CoreEvent) => void) => () => void;
}

export interface CoreRendererEventBridgeInput {
  core: ElectronCoreEventSource;
  readAppSnapshot: () => Promise<AppSnapshot>;
  publishAppSnapshot: (snapshot: AppSnapshot) => void;
  publishLogEntry: (entry: LogEntry) => void;
  publishChromeProfileImportProgress: (
    progress: ChromeProfileImportProgressRecord
  ) => void;
  refreshRoleOverlays?: (roleIds: readonly string[]) => Promise<unknown>;
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

export class CoreRendererEventBridge {
  readonly #input: CoreRendererEventBridgeInput;
  #unsubscribe: (() => void) | null = null;
  #refreshRequested = 0;
  #refreshRunning = false;
  #disposed = false;

  constructor(input: CoreRendererEventBridgeInput) {
    this.#input = input;
  }

  start(): void {
    if (this.#disposed) {
      throw new Error("The Core renderer event bridge has been disposed.");
    }
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#input.core.subscribeCoreEvents(this.#onCoreEvent);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#refreshRequested += 1;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  observeNativeProjectionChanged(): void {
    if (!this.#disposed) this.#requestSnapshotRefresh();
  }

  readonly #onCoreEvent = (event: CoreEvent): void => {
    if (this.#disposed) return;
    switch (event.type) {
      case "stateChanged":
      case "browserStatuses":
      case "macroStatuses":
        this.#requestSnapshotRefresh();
        break;
      case "logEntriesCaptured":
        for (const entry of event.entries) this.#input.publishLogEntry(entry);
        break;
      case "chromeProfileImportProgress":
        this.#input.publishChromeProfileImportProgress(event.progress);
        break;
      case "overlayChanged":
        this.#requestOverlayRefresh(event.roleIds);
        break;
      case "shutdown":
        this.dispose();
        break;
      default:
        break;
    }
  };

  #requestSnapshotRefresh(): void {
    this.#refreshRequested += 1;
    if (this.#refreshRunning) return;
    this.#refreshRunning = true;
    void this.#runSnapshotRefreshLane();
  }

  #requestOverlayRefresh(roleIds: readonly string[]): void {
    const refresh = this.#input.refreshRoleOverlays;
    if (!refresh) {
      this.#input.onError(normalizeRionBridgeError({
        code: "ELECTRON_ROLE_OVERLAY_REFRESH_UNAVAILABLE",
        message: "The Chromium overlay refresh coordinator is unavailable."
      }, "ELECTRON_ROLE_OVERLAY_REFRESH_UNAVAILABLE"));
      return;
    }
    const exactRoleIds = Object.freeze([...roleIds]);
    let operation: Promise<unknown>;
    try {
      operation = refresh(exactRoleIds);
    } catch (error) {
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_ROLE_OVERLAY_REFRESH_FAILED"
      ));
      return;
    }
    void Promise.resolve(operation).catch((error: unknown) => {
      if (this.#disposed) return;
      if (overlayRefreshWasSuperseded(error)) return;
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_ROLE_OVERLAY_REFRESH_FAILED"
      ));
    });
  }

  async #runSnapshotRefreshLane(): Promise<void> {
    while (!this.#disposed) {
      const requested = this.#refreshRequested;
      try {
        const snapshot = await this.#input.readAppSnapshot();
        if (!this.#disposed && requested === this.#refreshRequested) {
          this.#input.publishAppSnapshot(snapshot);
        }
      } catch (error) {
        if (!this.#disposed && requested === this.#refreshRequested) {
          this.#input.onError(normalizeRionBridgeError(
            error,
            "ELECTRON_APP_SNAPSHOT_REFRESH_FAILED"
          ));
        }
      }
      if (this.#disposed || requested === this.#refreshRequested) {
        this.#refreshRunning = false;
        return;
      }
    }
    this.#refreshRunning = false;
  }
}
