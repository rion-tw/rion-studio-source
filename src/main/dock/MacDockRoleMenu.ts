import { Menu } from "electron";

import type { AuthManager } from "../auth/AuthManager";
import type { BrowserManager } from "../browser/BrowserManager";
import type { RoleStore } from "../roles/RoleStore";
import { buildDockRoleMenuTemplate } from "./DockRoleMenuTemplate";

interface MacDockRoleMenuOptions {
  roleStore: Pick<RoleStore, "getRole" | "listRoles">;
  browserManager: Pick<BrowserManager, "launch" | "listStatuses" | "stopAll">;
  authManager: Pick<AuthManager, "listStatuses" | "startLogin">;
  dock: Electron.Dock;
  openApp: () => void;
  canUseApp: () => Promise<boolean>;
  logger?: Pick<Console, "error">;
}

export class MacDockRoleMenu {
  private readonly logger: Pick<Console, "error">;
  private refreshQueued = false;
  private refreshVersion = 0;

  constructor(private readonly options: MacDockRoleMenuOptions) {
    this.logger = options.logger ?? console;
  }

  scheduleRefresh(): void {
    if (this.refreshQueued) {
      return;
    }

    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    const version = ++this.refreshVersion;

    try {
      const [roles, statuses, authStatuses, legalAccepted] = await Promise.all([
        this.options.roleStore.listRoles(),
        Promise.resolve(this.options.browserManager.listStatuses()),
        Promise.resolve(this.options.authManager.listStatuses()),
        this.options.canUseApp()
      ]);

      if (version !== this.refreshVersion) {
        return;
      }

      const template = buildDockRoleMenuTemplate(
        {
          roles,
          statuses,
          authStatuses,
          legalAccepted
        },
        {
          openApp: this.options.openApp,
          launchRole: (roleId) => {
            void this.launchRole(roleId);
          },
          startLogin: (roleId) => {
            void this.startLogin(roleId);
          },
          stopAll: () => {
            void this.stopAll();
          }
        }
      );

      this.options.dock.setMenu(Menu.buildFromTemplate(template));
    } catch (error) {
      this.logger.error("Failed to refresh macOS Dock role menu.", error);
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
      this.logger.error(`Failed to launch role from Dock menu: ${roleId}`, error);
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
      this.logger.error(`Failed to start login from Dock menu: ${roleId}`, error);
    }
  }

  private async stopAll(): Promise<void> {
    try {
      await this.options.browserManager.stopAll();
      this.scheduleRefresh();
    } catch (error) {
      this.logger.error("Failed to stop roles from Dock menu.", error);
    }
  }
}
