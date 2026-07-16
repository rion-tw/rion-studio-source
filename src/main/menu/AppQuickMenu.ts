import { Menu } from "electron";

import type { PendingWorkspaceLaunchRequest } from "../../shared/types";
import type { AuthManager } from "../auth/AuthManager";
import type { BrowserManager } from "../browser/BrowserManager";
import type { RoleStore } from "../roles/RoleStore";
import type { LaunchWorkspaceStore } from "../workspaces/LaunchWorkspaceStore";
import type { WorkspaceLaunchCoordinator } from "../workspaces/WorkspaceLaunchCoordinator";
import { buildAppQuickMenuTemplate } from "./AppQuickMenuTemplate";

interface AppQuickMenuOptions {
  authManager: Pick<AuthManager, "listStatuses" | "startLogin">;
  browserManager: Pick<
    BrowserManager,
    "launch" | "listStatuses" | "listWorkspaceRuntimeStatuses" | "stopAll" | "stopWorkspace"
  >;
  canUseApp: () => Promise<boolean>;
  includeQuit: boolean;
  logger?: Pick<Console, "error">;
  onWorkspaceDisplaySelectionRequired: (request: PendingWorkspaceLaunchRequest) => void;
  openApp: () => void;
  quitApp?: () => void;
  roleStore: Pick<RoleStore, "getRole" | "listRoles">;
  setMenu: (menu: Menu) => void;
  workspaceLauncher: Pick<WorkspaceLaunchCoordinator, "launch">;
  workspaceStore: Pick<LaunchWorkspaceStore, "listWorkspaces">;
}

export class AppQuickMenu {
  private readonly logger: Pick<Console, "error">;
  private refreshQueued = false;
  private refreshVersion = 0;

  constructor(private readonly options: AppQuickMenuOptions) {
    this.logger = options.logger ?? console;
  }

  scheduleRefresh(): void {
    if (this.refreshQueued) return;

    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    const version = ++this.refreshVersion;

    try {
      const [roles, workspaces, statuses, workspaceStatuses, authStatuses, legalAccepted] =
        await Promise.all([
          this.options.roleStore.listRoles(),
          this.options.workspaceStore.listWorkspaces(),
          Promise.resolve(this.options.browserManager.listStatuses()),
          Promise.resolve(this.options.browserManager.listWorkspaceRuntimeStatuses()),
          Promise.resolve(this.options.authManager.listStatuses()),
          this.options.canUseApp()
        ]);

      if (version !== this.refreshVersion) return;

      const template = buildAppQuickMenuTemplate(
        {
          authStatuses,
          includeQuit: this.options.includeQuit,
          legalAccepted,
          roles,
          statuses,
          workspaces,
          workspaceStatuses
        },
        {
          openApp: this.options.openApp,
          launchRole: (roleId) => void this.launchRole(roleId),
          startLogin: (roleId) => void this.startLogin(roleId),
          launchWorkspace: (workspaceId) => void this.launchWorkspace(workspaceId),
          stopWorkspace: (workspaceId) => void this.stopWorkspace(workspaceId),
          stopAll: () => void this.stopAll(),
          ...(this.options.quitApp ? { quitApp: this.options.quitApp } : {})
        }
      );

      this.options.setMenu(Menu.buildFromTemplate(template));
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
      if (role.authState !== "authenticated") {
        this.options.authManager.startLogin(role);
        this.scheduleRefresh();
        return;
      }

      await this.options.browserManager.launch(role);
      this.scheduleRefresh();
    } catch (error) {
      this.logger.error(`Failed to launch role from app menu: ${roleId}`, error);
    }
  }

  private async startLogin(roleId: string): Promise<void> {
    try {
      if (!(await this.options.canUseApp())) {
        this.options.openApp();
        return;
      }
      const role = await this.options.roleStore.getRole(roleId);
      this.options.authManager.startLogin(role);
      this.scheduleRefresh();
    } catch (error) {
      this.logger.error(`Failed to start login from app menu: ${roleId}`, error);
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
