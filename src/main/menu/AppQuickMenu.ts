import { Menu } from "electron";

import type { PendingWorkspaceLaunchRequest } from "../../shared/types";
import type { ElectronBrowserRuntime } from "../browser/ElectronBrowserRuntime";
import type { RoleStore } from "../roles/RoleStore";
import type { LaunchWorkspaceStore } from "../workspaces/LaunchWorkspaceStore";
import type { WorkspaceLaunchCoordinator } from "../workspaces/WorkspaceLaunchCoordinator";
import { buildAppQuickMenuTemplate } from "./AppQuickMenuTemplate";

interface AppQuickMenuOptions {
  browserManager: Pick<
    ElectronBrowserRuntime,
    "launch" | "listEmbeddedRuntimeState" | "listStatuses" | "listWorkspaceRuntimeStatuses" |
      "showEmbeddedRuntimeWindows" | "stopAll" | "stopWorkspace"
  >;
  canUseApp: () => Promise<boolean>;
  includeQuit: boolean;
  logger?: Pick<Console, "error">;
  onWorkspaceDisplaySelectionRequired: (request: PendingWorkspaceLaunchRequest) => void;
  openApp: () => void;
  quitApp?: () => void;
  recordRefresh?: () => void;
  roleStore: Pick<RoleStore, "getRole" | "listRoles">;
  setMenu: (menu: Menu) => void;
  workspaceLauncher: Pick<WorkspaceLaunchCoordinator, "launch">;
  workspaceStore: Pick<LaunchWorkspaceStore, "listWorkspaces">;
}

export class AppQuickMenu {
  private readonly logger: Pick<Console, "error">;
  private refreshQueued = false;
  private refreshInFlight?: Promise<void>;
  private refreshTrailing = false;
  private refreshVersion = 0;

  constructor(private readonly options: AppQuickMenuOptions) {
    this.logger = options.logger ?? console;
  }

  scheduleRefresh(): void {
    if (this.refreshInFlight) {
      this.refreshTrailing = true;
      return;
    }
    if (this.refreshQueued) return;

    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.refreshInFlight) {
        this.refreshTrailing = true;
        return;
      }
      void this.runScheduledRefresh();
    });
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshTrailing = true;
      return this.refreshInFlight;
    }
    return this.runScheduledRefresh();
  }

  private runScheduledRefresh(): Promise<void> {
    const operation = this.refreshOnce();
    this.refreshInFlight = operation;
    void operation.finally(() => {
      if (this.refreshInFlight !== operation) return;
      this.refreshInFlight = undefined;
      if (this.refreshTrailing) {
        this.refreshTrailing = false;
        this.scheduleRefresh();
      }
    });
    return operation;
  }

  private async refreshOnce(): Promise<void> {
    const version = ++this.refreshVersion;

    try {
      const [roles, workspaces, statuses, workspaceStatuses, legalAccepted] =
        await Promise.all([
          this.options.roleStore.listRoles(),
          this.options.workspaceStore.listWorkspaces(),
          Promise.resolve(this.options.browserManager.listStatuses()),
          Promise.resolve(this.options.browserManager.listWorkspaceRuntimeStatuses()),
          this.options.canUseApp()
        ]);

      if (version !== this.refreshVersion) return;

      const template = buildAppQuickMenuTemplate(
        {
          includeQuit: this.options.includeQuit,
          legalAccepted,
          roles,
          runtimeWindows: this.options.browserManager.listEmbeddedRuntimeState().windows,
          statuses,
          workspaces,
          workspaceStatuses
        },
        {
          openApp: this.options.openApp,
          showAllGameWindows: () => this.options.browserManager.showEmbeddedRuntimeWindows(),
          showGameWindow: (displayId) => this.options.browserManager.showEmbeddedRuntimeWindows(displayId),
          launchRole: (roleId) => void this.launchRole(roleId),
          launchWorkspace: (workspaceId) => void this.launchWorkspace(workspaceId),
          stopWorkspace: (workspaceId) => void this.stopWorkspace(workspaceId),
          stopAll: () => void this.stopAll(),
          ...(this.options.quitApp ? { quitApp: this.options.quitApp } : {})
        }
      );

      this.options.setMenu(Menu.buildFromTemplate(template));
      this.options.recordRefresh?.();
    } catch (error) {
      this.logger.error("Failed to refresh the Rion Studio app menu.", error);
    }
  }

  private async launchRole(roleId: string): Promise<void> {
    try {
      if (!(await this.options.canUseApp())) {
        this.options.openApp();
        return;
      }

      const role = await this.options.roleStore.getRole(roleId);
      await this.options.browserManager.launch(role);
      this.scheduleRefresh();
    } catch (error) {
      this.logger.error(`Failed to launch role from app menu: ${roleId}`, error);
    }
  }

  private async launchWorkspace(workspaceId: string): Promise<void> {
    try {
      if (!(await this.options.canUseApp())) {
        this.options.openApp();
        return;
      }

      const result = await this.options.workspaceLauncher.launch(workspaceId);
      if (result.kind === "display_selection_required") {
        const workspace = (await this.options.workspaceStore.listWorkspaces())
          .find((item) => item.id === workspaceId);
        if (!workspace) throw new Error("Launch workspace not found.");

        this.options.onWorkspaceDisplaySelectionRequired({
          workspaceId,
          workspaceName: workspace.name,
          result
        });
      }
      this.scheduleRefresh();
    } catch (error) {
      this.logger.error(`Failed to launch workspace from app menu: ${workspaceId}`, error);
      this.scheduleRefresh();
    }
  }

  private async stopWorkspace(workspaceId: string): Promise<void> {
    try {
      await this.options.browserManager.stopWorkspace(workspaceId);
      this.scheduleRefresh();
    } catch (error) {
      this.logger.error(`Failed to stop workspace from app menu: ${workspaceId}`, error);
    }
  }

  private async stopAll(): Promise<void> {
    try {
      await this.options.browserManager.stopAll();
      this.scheduleRefresh();
    } catch (error) {
      this.logger.error("Failed to stop roles from app menu.", error);
    }
  }
}
