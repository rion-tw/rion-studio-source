import { BrowserWindow, ipcMain } from "electron";

import { IPC_CHANNELS } from "../../shared/ipc";
import type {
  AcceptLegalDocumentsInput,
  AppLanguage,
  AppRendererReadyState,
  AppUpdateStatus,
  AuthFlowStatus,
  CreateLaunchWorkspaceInput,
  CreateMacroInput,
  CreateRoleInput,
  GameBrowserSettings,
  MacroEditorRequest,
  MacroRunStatus,
  PortableExportInput,
  ReorderItemsInput,
  RoleStatus,
  UpdateLaunchWorkspaceInput,
  UpdateMacroInput,
  UpdateRoleInput
} from "../../shared/types";
import type { AuthManager } from "../auth/AuthManager";
import type { BrowserManager } from "../browser/BrowserManager";
import type { GameBrowserSettingsStore } from "../game-browser/GameBrowserSettingsStore";
import type { SystemFontService } from "../game-browser/SystemFontService";
import type { LegalAcceptanceStore } from "../legal/LegalAcceptanceStore";
import type { MacroManager } from "../macros/MacroManager";
import type { MacroOverlayRequest } from "../macros/MacroOverlayInjector";
import type { MacroStore } from "../macros/MacroStore";
import type { PortableDataManager } from "../portable/PortableDataManager";
import { RoleStore } from "../roles/RoleStore";
import type { AppUpdateManager } from "../updates/AppUpdateManager";
import { LaunchWorkspaceStore } from "../workspaces/LaunchWorkspaceStore";

interface RegisterIpcHandlersOptions {
  legalAcceptanceStore?: Pick<LegalAcceptanceStore, "accept" | "getStatus">;
  macroManager?: MacroManager;
  macroStore?: MacroStore;
  gameBrowserSettingsStore?: Pick<GameBrowserSettingsStore, "getSettings" | "updateSettings">;
  systemFontService?: Pick<SystemFontService, "listFonts">;
  updateManager?: AppUpdateManager;
  consumePendingMacroEditorRequest?: () => MacroEditorRequest | null;
  onMacrosChanged?: () => void;
  onMacroOverlayRequest?: (webContentsId: number, request: MacroOverlayRequest) => Promise<unknown>;
  onOverlayLanguageChanged?: (language: AppLanguage) => void;
  onLegalAccepted?: () => void;
  onRendererReady?: (senderId: number, state: AppRendererReadyState) => void;
  onRolesChanged?: () => void;
  onWorkspacesChanged?: () => void;
  portableDataManager?: Pick<PortableDataManager, "applyImport" | "exportData" | "previewImport">;
  quitApplication?: () => void;
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

  ipcMain.handle(IPC_CHANNELS.legalStatus, () => {
    if (!options.legalAcceptanceStore) {
      throw new Error("Legal acceptance is not available.");
    }

    return options.legalAcceptanceStore.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.legalAccept, async (_event, input: AcceptLegalDocumentsInput) => {
    if (!options.legalAcceptanceStore || !isAcceptLegalDocumentsInput(input)) {
      throw new Error("Legal acceptance input is invalid.");
    }

    const status = await options.legalAcceptanceStore.accept(input);
    options.onLegalAccepted?.();
    return status;
  });

  ipcMain.handle(IPC_CHANNELS.appQuit, () => {
    if (!options.quitApplication) {
      throw new Error("Application quit is not available.");
    }

    options.quitApplication();
  });

  ipcMain.handle(IPC_CHANNELS.preferencesSetOverlayLanguage, (_event, language: AppLanguage) => {
    if (!isAppLanguage(language)) {
      throw new Error("Language setting is invalid.");
    }

    options.onOverlayLanguageChanged?.(language);
  });

  ipcMain.handle(IPC_CHANNELS.macrosConsumeEditorRequest, () => options.consumePendingMacroEditorRequest?.() ?? null);

  ipcMain.handle(IPC_CHANNELS.macrosOverlayRequest, (event, request: MacroOverlayRequest) => {
    if (!options.onMacroOverlayRequest || !isMacroOverlayRequest(request)) {
      throw new Error("Macro overlay request is invalid.");
    }

    return options.onMacroOverlayRequest(event.sender.id, request);
  });

  ipcMain.handle(IPC_CHANNELS.portableExport, (_event, input?: PortableExportInput) => {
    if (!options.portableDataManager) {
      throw new Error("Portable data export is not available.");
    }

    return options.portableDataManager.exportData(input);
  });

  ipcMain.handle(IPC_CHANNELS.portableImportPreview, () => {
    if (!options.portableDataManager) {
      throw new Error("Portable data import is not available.");
    }

    return options.portableDataManager.previewImport();
  });

  ipcMain.handle(IPC_CHANNELS.portableImportApply, async (_event, importId: string) => {
    if (!options.portableDataManager || typeof importId !== "string" || !importId.trim()) {
      throw new Error("Portable data import is not available.");
    }

    const result = await options.portableDataManager.applyImport(importId);
    if (result.preferences?.gameBrowserSettings) {
      await options.gameBrowserSettingsStore?.updateSettings(result.preferences.gameBrowserSettings);
    }
    options.onRolesChanged?.();
    options.onWorkspacesChanged?.();
    options.onMacrosChanged?.();
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.gameBrowserSettingsGet, () => {
    if (!options.gameBrowserSettingsStore) {
      throw new Error("Game browser settings are not available.");
    }

    return options.gameBrowserSettingsStore.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.gameBrowserSettingsUpdate, (_event, settings: GameBrowserSettings) => {
    if (!options.gameBrowserSettingsStore) {
      throw new Error("Game browser settings are not available.");
    }

    return options.gameBrowserSettingsStore.updateSettings(settings);
  });

  ipcMain.handle(IPC_CHANNELS.systemFontsList, () => {
    if (!options.systemFontService) {
      throw new Error("System font list is not available.");
    }

    return options.systemFontService.listFonts();
  });

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

  ipcMain.handle(IPC_CHANNELS.rolesReorder, async (_event, input: ReorderItemsInput) => {
    const roles = await roleStore.reorderRoles(input);
    options.onRolesChanged?.();
    return roles;
  });

  ipcMain.handle(IPC_CHANNELS.rolesDelete, async (_event, id: string) => {
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

  ipcMain.handle(IPC_CHANNELS.workspacesReorder, async (_event, input: ReorderItemsInput) => {
    const workspaces = await workspaceStore.reorderWorkspaces(input);
    options.onWorkspacesChanged?.();
    return workspaces;
  });

  ipcMain.handle(IPC_CHANNELS.workspacesDelete, async (_event, id: string) => {
    await browserManager.stopWorkspace(id);
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

    return browserManager.launchWorkspace(
      workspace,
      launchItems.map(({ role, slot }) => ({ role, rect: slot.rect }))
    );
  });

  ipcMain.handle(IPC_CHANNELS.workspacesStop, async (_event, id: string) => {
    await browserManager.stopWorkspace(id);
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
      await macroManager.stop(id);
      await macroStore.deleteMacro(id);
      options.onMacrosChanged?.();
    });

    ipcMain.handle(IPC_CHANNELS.macrosStart, async (_event, macroId: string) => {
      return macroManager.start(macroId);
    });

    ipcMain.handle(IPC_CHANNELS.macrosStop, async (_event, macroId: string) => {
      await macroManager.stop(macroId);
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

function isAcceptLegalDocumentsInput(value: unknown): value is AcceptLegalDocumentsInput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const input = value as Partial<AcceptLegalDocumentsInput>;
  return (
    typeof input.termsVersion === "string" &&
    typeof input.fairUseVersion === "string" &&
    typeof input.privacyVersion === "string"
  );
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

function isMacroOverlayRequest(value: unknown): value is MacroOverlayRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const request = value as { macroId?: unknown; type?: unknown };
  if (request.type === "list" || request.type === "create") {
    return true;
  }

  return (
    (request.type === "edit" || request.type === "start" || request.type === "stop") &&
    typeof request.macroId === "string" &&
    request.macroId.length > 0
  );
}
