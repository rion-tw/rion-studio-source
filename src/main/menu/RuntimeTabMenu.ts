import { Menu, type BaseWindow, type MenuItemConstructorOptions } from "electron";

import type { AppLanguage, PendingWorkspaceLaunchRequest, WorkspaceDisplayInfo } from "../../shared/types";
import type { ElectronBrowserRuntime } from "../browser/ElectronBrowserRuntime";
import type { RoleStore } from "../roles/RoleStore";
import type { LaunchWorkspaceStore } from "../workspaces/LaunchWorkspaceStore";
import type { WorkspaceLaunchCoordinator } from "../workspaces/WorkspaceLaunchCoordinator";

type RuntimeMenuLabelKey = "roles" | "workspaces" | "noRoles" | "noWorkspaces" |
  "move" | "display" | "hide" | "stop" | "mute" | "unmute";

const labels: Record<AppLanguage, Record<RuntimeMenuLabelKey, string>> = {
  en: {
    roles: "Roles",
    workspaces: "Workspaces",
    noRoles: "No Roles",
    noWorkspaces: "No Workspaces",
    move: "Move to Display",
    display: "Display",
    hide: "Hide tab (keeps running)",
    stop: "Stop and Close",
    mute: "Mute Tab",
    unmute: "Unmute Tab"
  },
  "zh-TW": {
    roles: "角色",
    workspaces: "工作區",
    noRoles: "沒有角色",
    noWorkspaces: "沒有工作區",
    move: "移至顯示器",
    display: "顯示器",
    hide: "隱藏分頁（保持運行）",
    stop: "停止並關閉",
    mute: "將分頁靜音",
    unmute: "取消分頁靜音"
  },
  "zh-CN": {
    roles: "角色",
    workspaces: "工作区",
    noRoles: "没有角色",
    noWorkspaces: "没有工作区",
    move: "移至显示器",
    display: "显示器",
    hide: "隐藏标签页（保持运行）",
    stop: "停止并关闭",
    mute: "将标签页静音",
    unmute: "取消标签页静音"
  },
  ja: {
    roles: "ロール",
    workspaces: "ワークスペース",
    noRoles: "ロールなし",
    noWorkspaces: "ワークスペースなし",
    move: "ディスプレイへ移動",
    display: "ディスプレイ",
    hide: "タブを非表示（実行を継続）",
    stop: "停止して閉じる",
    mute: "タブをミュート",
    unmute: "タブのミュートを解除"
  }
};

interface RuntimeTabMenuOptions {
  browserManager: Pick<
    ElectronBrowserRuntime,
    "acquireRuntimeToolbarRevealLock" | "launch" | "listEmbeddedRuntimeState" |
      "hideRuntimeTab" | "moveRuntimeTab" | "setRuntimeTabAudioMuted" |
      "showRuntimeTab" | "stopRuntimeTab"
  >;
  getWorkspaceDisplays: () => WorkspaceDisplayInfo[];
  logger?: Pick<Console, "error">;
  onWorkspaceDisplaySelectionRequired: (request: PendingWorkspaceLaunchRequest) => void;
  roleStore: Pick<RoleStore, "getRole" | "listRoles">;
  workspaceLauncher: Pick<WorkspaceLaunchCoordinator, "launch">;
  workspaceStore: Pick<LaunchWorkspaceStore, "getWorkspace" | "listWorkspaces">;
}

export class RuntimeTabMenuController {
  private language: AppLanguage = "en";
  private readonly logger: Pick<Console, "error">;

  constructor(private readonly options: RuntimeTabMenuOptions) {
    this.logger = options.logger ?? console;
  }

  setLanguage(language: AppLanguage): void {
    this.language = language;
  }

  async openLauncher(window: BaseWindow, sourceDisplayId: number): Promise<void> {
    const [roles, workspaces] = await Promise.all([
      this.options.roleStore.listRoles(),
      this.options.workspaceStore.listWorkspaces()
    ]);
    if (window.isDestroyed()) return;

    const state = this.options.browserManager.listEmbeddedRuntimeState();
    const tabByRoleId = new Map(
      state.tabs.flatMap((tab) => tab.roleIds.map((roleId) => [roleId, tab] as const))
    );
    const tabByWorkspaceId = new Map(
      state.tabs.flatMap((tab) => tab.type === "workspace"
        ? [[tab.sourceId, tab] as const]
        : [])
    );
    const text = labels[this.language];
    const template: MenuItemConstructorOptions[] = [
      {
        label: text.roles,
        submenu: roles.length === 0
          ? [{ label: text.noRoles, enabled: false }]
          : roles.map((role) => {
              const existing = tabByRoleId.get(role.id);
              return {
                label: role.name,
                ...(existing ? { checked: true, type: "checkbox" as const } : {}),
                click: () => {
                  if (existing) {
                    void this.options.browserManager.showRuntimeTab(existing.id);
                    return;
                  }
                  void this.launchRole(role.id, sourceDisplayId);
                }
              };
            })
      },
      {
        label: text.workspaces,
        submenu: workspaces.length === 0
          ? [{ label: text.noWorkspaces, enabled: false }]
          : workspaces.map((workspace) => {
              const existing = tabByWorkspaceId.get(workspace.id);
              return {
                label: workspace.name,
                ...(existing ? { checked: true, type: "checkbox" as const } : {}),
                click: () => {
                  if (existing) {
                    void this.options.browserManager.showRuntimeTab(existing.id);
                    return;
                  }
                  void this.launchWorkspace(workspace.id, sourceDisplayId);
                }
              };
            })
      }
    ];

    this.popupWithRevealLock(window, sourceDisplayId, template);
  }

  openTabMenu(window: BaseWindow, sourceDisplayId: number, tabId: string): void {
    const tab = this.options.browserManager.listEmbeddedRuntimeState().tabs.find(
      (candidate) => candidate.id === tabId && candidate.displayId === sourceDisplayId
    );
    if (!tab || window.isDestroyed()) return;

    const text = labels[this.language];
    const displays = this.options.getWorkspaceDisplays();
    const template: MenuItemConstructorOptions[] = [
      {
        label: text.move,
        submenu: displays.map((display) => ({
          enabled: display.id !== sourceDisplayId,
          label: display.label || `${text.display} ${display.id}`,
          click: () => void this.options.browserManager.moveRuntimeTab(tabId, display.id)
        }))
      },
      {
        checked: tab.audioMuted,
        click: () => {
          const currentTab = this.options.browserManager.listEmbeddedRuntimeState().tabs.find(
            (candidate) => candidate.id === tabId
          );
          if (currentTab) {
            this.options.browserManager.setRuntimeTabAudioMuted(tabId, !currentTab.audioMuted);
          }
        },
        label: tab.audioMuted ? text.unmute : text.mute,
        type: "checkbox"
      },
      { type: "separator" },
      {
        label: text.hide,
        click: () => {
          void this.options.browserManager.hideRuntimeTab(tabId).catch((error) => {
            this.logger.error(`Failed to hide runtime tab: ${tabId}`, error);
          });
        }
      },
      { type: "separator" },
      {
        label: text.stop,
        click: () => {
          void this.options.browserManager.stopRuntimeTab(tabId).catch((error) => {
            this.logger.error(`Failed to stop runtime tab: ${tabId}`, error);
          });
        }
      }
    ];
    this.popupWithRevealLock(window, sourceDisplayId, template);
  }

  private popupWithRevealLock(
    window: BaseWindow,
    displayId: number,
    template: MenuItemConstructorOptions[]
  ): void {
    const releaseRevealLock = this.options.browserManager.acquireRuntimeToolbarRevealLock(displayId);
    try {
      Menu.buildFromTemplate(template).popup({
        callback: releaseRevealLock,
        window
      });
    } catch (error) {
      releaseRevealLock();
      throw error;
    }
  }

  private async launchRole(roleId: string, displayId: number): Promise<void> {
    try {
      const role = await this.options.roleStore.getRole(roleId);
      const display = this.options.getWorkspaceDisplays().find((candidate) => candidate.id === displayId);
      const launchOptions = display
        ? { target: { displayId, workArea: display.workArea } }
        : undefined;
      await this.options.browserManager.launch(role, launchOptions);
    } catch (error) {
      this.logger.error(`Failed to launch role from runtime menu: ${roleId}`, error);
    }
  }

  private async launchWorkspace(workspaceId: string, displayId: number): Promise<void> {
    try {
      const workspace = await this.options.workspaceStore.getWorkspace(workspaceId);
      const result = workspace.targetDisplay
        ? await this.options.workspaceLauncher.launch(workspaceId)
        : await this.options.workspaceLauncher.launch(workspaceId, { displayId });
      if (result.kind === "display_selection_required") {
        this.options.onWorkspaceDisplaySelectionRequired({
          workspaceId,
          workspaceName: workspace.name,
          result
        });
      }
    } catch (error) {
      this.logger.error(`Failed to launch workspace from runtime menu: ${workspaceId}`, error);
    }
  }
}
