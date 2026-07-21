import type {
  BrowserLaunchMode,
  RoleStatus,
  WorkspaceDisplayInfo,
  WorkspaceDisplayLaunchOption,
  WorkspaceLaunchInput,
  WorkspaceLaunchResult
} from "../../shared/types";
import { resolveWorkspaceDisplayTarget } from "../../shared/workspaceDisplays";
import {
  BrowserWorkspaceDisplayOccupiedError,
  EXTERNAL_COMPAT_NOTICE,
  type BrowserManager
} from "../browser/BrowserManager";
import type { GameBrowserSettingsStore } from "../game-browser/GameBrowserSettingsStore";
import type { GameCompatibilityManager } from "../games/GameCompatibilityManager";
import type { RoleStore } from "../roles/RoleStore";
import type { LaunchWorkspaceStore } from "./LaunchWorkspaceStore";

interface WorkspaceLaunchCoordinatorOptions {
  browserManager: Pick<BrowserManager, "launchWorkspace" | "listWorkspaceDisplayReservations">;
  gameBrowserSettingsStore?: Pick<GameBrowserSettingsStore, "getSettings">;
  gameCompatibilityManager?: Pick<GameCompatibilityManager, "recordObservation">;
  getDefaultWorkspaceDisplayId?: () => number;
  getWorkspaceDisplays?: () => WorkspaceDisplayInfo[];
  roleStore: Pick<RoleStore, "getRole">;
  workspaceStore: Pick<LaunchWorkspaceStore, "getWorkspace">;
}

export class WorkspaceLaunchCoordinator {
  constructor(private readonly options: WorkspaceLaunchCoordinatorOptions) {}

  async launch(id: string, input?: WorkspaceLaunchInput): Promise<WorkspaceLaunchResult> {
    const workspace = await this.options.workspaceStore.getWorkspace(id);
    const launchSlots = workspace.slots.filter((slot) => slot.roleId);

    if (launchSlots.length === 0) {
      throw new Error("Launch workspace has no roles.");
    }

    const launchItems = await Promise.all(
      launchSlots.map(async (slot) => ({
        slot,
        role: await this.options.roleStore.getRole(slot.roleId ?? "")
      }))
    );
    const displays = this.getWorkspaceDisplays();
    const targetDisplay = input?.displayId !== undefined
      ? displays.find((display) => display.id === input.displayId)
      : workspace.targetDisplay
        ? resolveWorkspaceDisplayTarget(workspace.targetDisplay, displays)
        : displays.find((display) =>
            display.id === (this.options.getDefaultWorkspaceDisplayId?.() ?? displays[0]?.id)
          );
    const launchOptions = this.createDisplayLaunchOptions(displays, workspace.id);
    const globalLaunchMode = await this.getGlobalLaunchMode();
    const workspaceLaunchMode = workspace.browserLaunchMode === "inherit"
      ? globalLaunchMode
      : workspace.browserLaunchMode;
    const selectableDisplays = workspaceLaunchMode === "external" ? launchOptions : displays;

    if (!targetDisplay) {
      return {
        kind: "display_selection_required",
        reason: "target_unavailable",
        displays: selectableDisplays
      };
    }

    if (
      workspaceLaunchMode === "external" &&
      launchOptions.find((display) => display.id === targetDisplay.id)?.occupiedByWorkspace
    ) {
      return {
        kind: "display_selection_required",
        reason: "target_occupied",
        displays: selectableDisplays
      };
    }

    try {
      const statuses = await this.options.browserManager.launchWorkspace(
        workspace,
        launchItems.map(({ role, slot }) => ({
          role,
          rect: slot.rect,
          ...(slot.browserZoomPercent === undefined
            ? {}
            : { browserZoomPercent: slot.browserZoomPercent })
        })),
        { displayId: targetDisplay.id, workArea: targetDisplay.workArea },
        workspaceLaunchMode
      );
      await Promise.all(statuses.map((status) => {
        const role = launchItems.find((item) => item.role.id === status.roleId)?.role;
        return role ? this.recordLaunchSuccess(role.gameId, status) : Promise.resolve();
      }));
      return {
        kind: "launched",
        displayId: targetDisplay.id,
        statuses
      };
    } catch (error) {
      if (error instanceof BrowserWorkspaceDisplayOccupiedError) {
        return {
          kind: "display_selection_required",
          reason: "target_occupied",
          displays: this.createDisplayLaunchOptions(this.getWorkspaceDisplays(), workspace.id)
        };
      }

      await Promise.all(
        [...new Set(launchItems.map((item) => item.role.gameId))]
          .map((gameId) => this.recordLaunchFailure(gameId, error))
      );
      throw error;
    }
  }

  private createDisplayLaunchOptions(
    displays: WorkspaceDisplayInfo[],
    launchingWorkspaceId: string
  ): WorkspaceDisplayLaunchOption[] {
    const reservationByDisplayId = new Map(
      this.options.browserManager.listWorkspaceDisplayReservations()
        .filter((reservation) => reservation.workspaceId !== launchingWorkspaceId)
        .map((reservation) => [reservation.displayId, reservation] as const)
    );

    return displays.map((display) => {
      const reservation = reservationByDisplayId.get(display.id);
      return {
        ...display,
        ...(reservation
          ? {
              occupiedByWorkspace: {
                id: reservation.workspaceId,
                name: reservation.workspaceName
              }
            }
          : {})
      };
    });
  }

  private getWorkspaceDisplays(): WorkspaceDisplayInfo[] {
    return this.options.getWorkspaceDisplays?.() ?? [DEFAULT_WORKSPACE_DISPLAY];
  }

  private async getGlobalLaunchMode(): Promise<BrowserLaunchMode> {
    return this.options.gameBrowserSettingsStore
      ? (await this.options.gameBrowserSettingsStore.getSettings()).launchMode
      : "embedded";
  }

  private async recordLaunchSuccess(gameId: string, status: RoleStatus): Promise<void> {
    if (!this.options.gameCompatibilityManager) {
      return;
    }

    const timestamp = new Date().toISOString();
    await this.options.gameCompatibilityManager.recordObservation(gameId, status.runtimeMode === "external"
      ? {
          lastExternalSuccessAt: timestamp,
          ...(status.notice?.includes(EXTERNAL_COMPAT_NOTICE) ? { lastFallbackAt: timestamp } : {})
        }
      : { lastEmbeddedSuccessAt: timestamp });
  }

  private async recordLaunchFailure(gameId: string, error: unknown): Promise<void> {
    if (!this.options.gameCompatibilityManager) {
      return;
    }

    await this.options.gameCompatibilityManager.recordObservation(gameId, {
      lastLaunchFailureAt: new Date().toISOString(),
      lastLaunchFailureCode: readErrorCode(error)
    });
  }
}

const DEFAULT_WORKSPACE_DISPLAY: WorkspaceDisplayInfo = {
  id: 0,
  label: "",
  bounds: { x: 0, y: 0, width: 1200, height: 800 },
  workArea: { x: 0, y: 0, width: 1200, height: 800 },
  resolution: { width: 1200, height: 800 },
  scaleFactor: 1,
  isPrimary: true,
  isInternal: false
};

function readErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return "LAUNCH_FAILED";
}
