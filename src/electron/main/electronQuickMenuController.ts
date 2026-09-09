import type {
  CoreAppSnapshotRecord,
  CoreEvent,
  LegalAcceptanceStatusRecord
} from "../../shared/generated";
import type { AppLanguage } from "../../shared/types";
import { normalizeRionBridgeError } from "../ipc/errors";
import {
  buildElectronQuickMenuModel,
  buildElectronQuickMenuStarter,
  type ElectronQuickMenuEntry,
  type ElectronQuickMenuPlatform
} from "./electronQuickMenuModel";

interface ElectronQuickMenuStateSource {
  read: () => Promise<Readonly<{
    legal: LegalAcceptanceStatusRecord;
    snapshot: CoreAppSnapshotRecord;
  }>>;
  subscribe: (listener: (event: CoreEvent) => void) => () => void;
}

interface ElectronQuickMenuActions {
  readonly launchRole: (roleId: string) => Promise<unknown>;
  readonly launchWorkspace: (workspaceId: string) => Promise<unknown>;
  readonly presentMainWindow: () => Promise<void>;
  readonly requestQuit: () => Promise<void>;
  readonly showGameWindow: (windowId: string) => Promise<void>;
  readonly stopAllRoles: () => Promise<void>;
}

export interface ElectronQuickMenuControllerInput {
  readonly actions: ElectronQuickMenuActions;
  readonly apply: (
    entries: readonly ElectronQuickMenuEntry[],
    onAction: (id: string) => void
  ) => void;
  readonly initialLanguage: AppLanguage;
  readonly onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
  readonly platform: ElectronQuickMenuPlatform;
  readonly state: ElectronQuickMenuStateSource;
}

function actionTarget(id: string, prefix: string): string | null {
  if (!id.startsWith(prefix)) return null;
  const target = id.slice(prefix.length);
  return target.length === 0 ? null : target;
}

/** Coalesces event-driven Core/native projections into one native menu model. */
export class ElectronQuickMenuController {
  readonly #input: ElectronQuickMenuControllerInput;
  #language: AppLanguage;
  #lastFingerprint: string | null = null;
  #refreshRequested = 0;
  #refreshRunning = false;
  #unsubscribe: (() => void) | null = null;
  #disposed = false;

  constructor(input: ElectronQuickMenuControllerInput) {
    this.#input = input;
    this.#language = input.initialLanguage;
  }

  start(): void {
    if (this.#disposed) {
      throw new Error("The Electron Quick Menu controller has been disposed.");
    }
    if (this.#unsubscribe) return;
    this.#input.apply(
      buildElectronQuickMenuStarter(this.#language, this.#input.platform),
      this.#onAction
    );
    this.#unsubscribe = this.#input.state.subscribe(this.#onCoreEvent);
    this.#requestRefresh();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#refreshRequested += 1;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  observeNativeProjectionChanged(): void {
    if (!this.#disposed) this.#requestRefresh();
  }

  setLanguage(language: AppLanguage): void {
    if (this.#disposed || this.#language === language) return;
    this.#language = language;
    this.#lastFingerprint = null;
    this.#requestRefresh();
  }

  readonly #onCoreEvent = (event: CoreEvent): void => {
    if (this.#disposed) return;
    switch (event.type) {
      case "stateChanged":
      case "browserStatuses":
        this.#requestRefresh();
        break;
      case "shutdown":
        this.dispose();
        break;
      default:
        break;
    }
  };

  readonly #onAction = (id: string): void => {
    if (this.#disposed) return;
    if (
      id.startsWith("launch-role:") ||
      id.startsWith("launch-workspace:") ||
      id.startsWith("show-display:") ||
      id.startsWith("restore-window:")
    ) {
      this.#lastFingerprint = null;
      this.#requestRefresh();
    }
    void this.#execute(id).catch((error: unknown) => {
      if (this.#disposed) return;
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_QUICK_MENU_ACTION_FAILED"
      ));
    });
  };

  async #execute(id: string): Promise<void> {
    if (id === "open-app" || id === "review-terms") {
      await this.#input.actions.presentMainWindow();
      return;
    }
    if (id === "quit-app") {
      await this.#input.actions.requestQuit();
      return;
    }
    if (id === "stop-all") {
      await this.#input.actions.stopAllRoles();
      return;
    }
    const roleId = actionTarget(id, "launch-role:");
    if (roleId) {
      await this.#input.actions.launchRole(roleId);
      return;
    }
    const workspaceId = actionTarget(id, "launch-workspace:");
    if (workspaceId) {
      await this.#input.actions.launchWorkspace(workspaceId);
      return;
    }
    const windowId = actionTarget(id, "show-display:") ??
      actionTarget(id, "restore-window:");
    if (windowId) await this.#input.actions.showGameWindow(windowId);
  }

  #requestRefresh(): void {
    this.#refreshRequested += 1;
    if (this.#refreshRunning) return;
    this.#refreshRunning = true;
    void this.#runRefreshLane();
  }

  async #runRefreshLane(): Promise<void> {
    while (!this.#disposed) {
      const requested = this.#refreshRequested;
      try {
        const state = await this.#input.state.read();
        const model = buildElectronQuickMenuModel({
          language: this.#language,
          legal: state.legal,
          platform: this.#input.platform,
          snapshot: state.snapshot
        });
        const fingerprint = JSON.stringify(model);
        if (
          !this.#disposed &&
          requested === this.#refreshRequested &&
          fingerprint !== this.#lastFingerprint
        ) {
          this.#input.apply(model, this.#onAction);
          this.#lastFingerprint = fingerprint;
        }
      } catch (error) {
        if (!this.#disposed && requested === this.#refreshRequested) {
          this.#input.onError(normalizeRionBridgeError(
            error,
            "ELECTRON_QUICK_MENU_REFRESH_FAILED"
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
