import { BrowserWindow, ipcMain, screen } from "electron";

import { IPC_CHANNELS } from "../../shared/ipc";
import type {
  AppLanguage,
  AppRendererReadyState,
  AppUpdateStatus,
  AuthFlowStatus,
  CreateLaunchWorkspaceInput,
  CreateMacroInput,
  CreateRoleInput,
  MacroEditorRequest,
  MacroRunStatus,
  NormalizedRect,
  PixelBounds,
  RoleStatus,
  UpdateLaunchWorkspaceInput,
  UpdateMacroInput,
  UpdateRoleInput
} from "../../shared/types";
import type { AuthManager } from "../auth/AuthManager";
import type { BrowserManager } from "../browser/BrowserManager";
import type { MacroManager } from "../macros/MacroManager";
import type { MacroStore } from "../macros/MacroStore";
import { RoleStore } from "../roles/RoleStore";
import type { AppUpdateManager } from "../updates/AppUpdateManager";
import { LaunchWorkspaceStore } from "../workspaces/LaunchWorkspaceStore";

interface RegisterIpcHandlersOptions {
  getLaunchWorkArea?: () => Electron.Rectangle;
  macroManager?: MacroManager;
  macroStore?: MacroStore;
  updateManager?: AppUpdateManager;
  consumePendingMacroEditorRequest?: () => MacroEditorRequest | null;
  onMacrosChanged?: () => void;
  onOverlayLanguageChanged?: (language: AppLanguage) => void;
  onRendererReady?: (senderId: number, state: AppRendererReadyState) => void;
  onRolesChanged?: () => void;
  onWorkspacesChanged?: () => void;
}

export function registerIpcHandlers(
  roleStore: RoleStore,
  workspaceStore: LaunchWorkspaceStore,
  browserManager: BrowserManager,
  authManager: AuthManager,
  options: RegisterIpcHandlersOptions = {}
): void {
  browserManager.on("change", (statuses) => {
    broadcastStatusChange(statuses);
  });
  authManager.on("change", (statuses) => {
    broadcastAuthStatusChange(statuses);
  });
  options.macroManager?.on("change", (statuses) => {
    broadcastMacroStatusChange(statuses);
  });
  options.updateManager?.on("change", (status) => {
    broadcastUpdateStatusChange(status);
  });

  ipcMain.handle(IPC_CHANNELS.appRendererReady, (event, state: AppRendererReadyState) => {
    if (!isAppRendererReadyState(state)) {
      throw new Error("Renderer readiness state is invalid.");
    }

    options.onRendererReady?.(event.sender.id, state);
  });

  ipcMain.handle(IPC_CHANNELS.preferencesSetOverlayLanguage, (_event, language: AppLanguage) => {
    if (!isAppLanguage(language)) {
      throw new Error("Language setting is invalid.");
    }

    options.onOverlayLanguageChanged?.(language);
  });

  ipcMain.handle(IPC_CHANNELS.macrosConsumeEditorRequest, () => options.consumePendingMacroEditorRequest?.() ?? null);

  ipcMain.handle(IPC_CHANNELS.appVersion, () => options.updateManager?.getStatus().currentVersion ?? "");

  ipcMain.handle(IPC_CHANNELS.updatesStatus, () => options.updateManager?.getStatus());

  ipcMain.handle(IPC_CHANNELS.updatesCheck, () => {
    if (!options.updateManager) {
      throw new Error("Update manager is not available.");
    }

    return options.updateManager.checkForUpdates();
  });

  ipcMain.handle(IPC_CHANNELS.updatesOpenDownload, () => {
    if (!options.updateManager) {
      throw new Error("Update manager is not available.");
    }

    return options.updateManager.openUpdateDownload();
  });

  ipcMain.handle(IPC_CHANNELS.updatesInstall, () => {
    if (!options.updateManager) {
      throw new Error("Update manager is not available.");
    }

    options.updateManager.installDownloadedUpdate();
  });

  ipcMain.handle(IPC_CHANNELS.rolesList, () => roleStore.listRoles());

  ipcMain.handle(IPC_CHANNELS.rolesCreate, async (_event, input: CreateRoleInput) => {
    const role = await roleStore.createRole(input);
    options.onRolesChanged?.();
    return role;
  });

  ipcMain.handle(IPC_CHANNELS.rolesUpdate, async (_event, id: string, input: UpdateRoleInput) => {
    const role = await roleStore.updateRole(id, input);
    options.onRolesChanged?.();
    return role;
  });

  ipcMain.handle(IPC_CHANNELS.rolesDelete, async (_event, id: string) => {
    await options.macroManager?.stopRole(id);
    await browserManager.stop(id);
    await roleStore.deleteRole(id);
    await workspaceStore.clearRole(id);
    await options.macroStore?.deleteRoleMacros(id);
    options.onRolesChanged?.();
    options.onWorkspacesChanged?.();
    options.onMacrosChanged?.();
  });

  ipcMain.handle(IPC_CHANNELS.rolesPaths, async (_event, id: string) => {
    await roleStore.getRole(id);
    return roleStore.getRolePaths(id);
  });

  ipcMain.handle(IPC_CHANNELS.rolesStartLogin, async (_event, id: string) => {
    const role = await roleStore.getRole(id);
    return authManager.startLogin(role);
  });

  ipcMain.handle(IPC_CHANNELS.rolesAuthStatuses, () => authManager.listStatuses());

  ipcMain.handle(IPC_CHANNELS.rolesLaunch, async (_event, id: string) => {
    const role = await roleStore.getRole(id);

    if (role.authState !== "authenticated") {
      throw new Error("Login required. Use Login before launching this role.");
    }

    return browserManager.launch(role);
  });

  ipcMain.handle(IPC_CHANNELS.rolesOpenSystemLogin, async (_event, id: string) => {
    const role = await roleStore.getRole(id);
    await browserManager.stop(id);
    return authManager.startLogin(role);
  });

  ipcMain.handle(IPC_CHANNELS.rolesStop, async (_event, id: string) => {
    await options.macroManager?.stopRole(id);
    await browserManager.stop(id);
  });

  ipcMain.handle(IPC_CHANNELS.rolesStatuses, () => browserManager.listStatuses());

  ipcMain.handle(IPC_CHANNELS.workspacesList, () => workspaceStore.listWorkspaces());

  ipcMain.handle(IPC_CHANNELS.workspacesCreate, async (_event, input: CreateLaunchWorkspaceInput) => {
    const workspace = await workspaceStore.createWorkspace(input);
    options.onWorkspacesChanged?.();
    return workspace;
  });

  ipcMain.handle(
    IPC_CHANNELS.workspacesUpdate,
    async (_event, id: string, input: UpdateLaunchWorkspaceInput) => {
      const workspace = await workspaceStore.updateWorkspace(id, input);
      options.onWorkspacesChanged?.();
      return workspace;
    }
  );

  ipcMain.handle(IPC_CHANNELS.workspacesDelete, async (_event, id: string) => {
    await workspaceStore.deleteWorkspace(id);
    options.onWorkspacesChanged?.();
  });

  ipcMain.handle(IPC_CHANNELS.workspacesLaunch, async (_event, id: string) => {
    const workspace = await workspaceStore.getWorkspace(id);
    const launchSlots = workspace.slots.filter((slot) => slot.roleId);

    if (launchSlots.length === 0) {
      throw new Error("Launch workspace has no roles.");
    }

    const launchItems = await Promise.all(
      launchSlots.map(async (slot) => ({
        slot,
        role: await roleStore.getRole(slot.roleId ?? "")
      }))
    );

    const unauthenticatedRole = launchItems.find((item) => item.role.authState !== "authenticated");

    if (unauthenticatedRole) {
      throw new Error("Login required. Use Login before launching every role in this workspace.");
    }

    const workArea = options.getLaunchWorkArea?.() ?? screen.getPrimaryDisplay().workArea;
    const statuses: RoleStatus[] = [];

    for (const { role, slot } of launchItems) {
      statuses.push(
        await browserManager.launch(role, {
          bounds: normalizedRectToPixelBounds(slot.rect, workArea),
          zoomFactor: workspace.browserZoomPercent / 100
        })
      );
    }

    return statuses;
  });

  ipcMain.handle(IPC_CHANNELS.workspacesStop, async (_event, id: string) => {
    const workspace = await workspaceStore.getWorkspace(id);
    await Promise.all(
      workspace.slots
        .map((slot) => slot.roleId)
        .filter((roleId): roleId is string => Boolean(roleId))
        .map((roleId) => options.macroManager?.stopRole(roleId))
    );
    await Promise.all(
      workspace.slots
        .map((slot) => slot.roleId)
        .filter((roleId): roleId is string => Boolean(roleId))
        .map((roleId) => browserManager.stop(roleId))
    );
  });

  if (options.macroStore && options.macroManager) {
    const { macroManager, macroStore } = options;

    ipcMain.handle(IPC_CHANNELS.macrosList, () => macroStore.listMacros());

    ipcMain.handle(IPC_CHANNELS.macrosCreate, async (_event, input: CreateMacroInput) => {
      const macro = await macroStore.createMacro(input);
      options.onMacrosChanged?.();
      return macro;
    });

    ipcMain.handle(IPC_CHANNELS.macrosUpdate, async (_event, id: string, input: UpdateMacroInput) => {
      const macro = await macroStore.updateMacro(id, input);
      options.onMacrosChanged?.();
      return macro;
    });

    ipcMain.handle(IPC_CHANNELS.macrosDelete, async (_event, id: string) => {
      await Promise.all(
        macroManager
          .listStatuses()
          .filter((status) => status.macroId === id)
          .map((status) => macroManager.stop(status.roleId, status.macroId))
      );
      await macroStore.deleteMacro(id);
      options.onMacrosChanged?.();
    });

    ipcMain.handle(IPC_CHANNELS.macrosStart, async (_event, roleId: string, macroId: string) => {
      return macroManager.start(roleId, macroId);
    });

    ipcMain.handle(IPC_CHANNELS.macrosStop, async (_event, roleId: string, macroId: string) => {
      await macroManager.stop(roleId, macroId);
    });

    ipcMain.handle(IPC_CHANNELS.macrosStatuses, () => macroManager.listStatuses());
  }
}

function isAppRendererReadyState(value: unknown): value is AppRendererReadyState {
  return value === "ready" || value === "failed";
}

function isAppLanguage(value: unknown): value is AppLanguage {
  return value === "en" || value === "zh-TW" || value === "zh-CN" || value === "ja";
}

function broadcastStatusChange(statuses: RoleStatus[]): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.rolesStatusChanged, statuses);
  });
}

function broadcastAuthStatusChange(statuses: AuthFlowStatus[]): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.rolesAuthStatusChanged, statuses);
  });
}

function broadcastMacroStatusChange(statuses: MacroRunStatus[]): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.macrosStatusChanged, statuses);
  });
}

function broadcastUpdateStatusChange(status: AppUpdateStatus): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.updatesStatusChanged, status);
  });
}

function normalizedRectToPixelBounds(rect: NormalizedRect, workArea: Electron.Rectangle): PixelBounds {
  return {
    x: Math.round(workArea.x + rect.x * workArea.width),
    y: Math.round(workArea.y + rect.y * workArea.height),
    width: Math.max(1, Math.round(rect.width * workArea.width)),
    height: Math.max(1, Math.round(rect.height * workArea.height))
  };
}
