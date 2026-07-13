import { contextBridge, ipcRenderer } from "electron";

import { IPC_CHANNELS } from "../shared/ipc";
import type { RionStudioApi } from "../shared/api";
import type {
  AppUpdateStatus,
  AuthFlowStatus,
  MacroEditorRequest,
  MacroRunStatus,
  RoleStatus
} from "../shared/types";

const api: RionStudioApi = {
  notifyAppReady: (state) => ipcRenderer.invoke(IPC_CHANNELS.appRendererReady, state),
  listRoles: () => ipcRenderer.invoke(IPC_CHANNELS.rolesList),
  createRole: (input) => ipcRenderer.invoke(IPC_CHANNELS.rolesCreate, input),
  updateRole: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.rolesUpdate, id, input),
  reorderRoles: (input) => ipcRenderer.invoke(IPC_CHANNELS.rolesReorder, input),
  deleteRole: (id) => ipcRenderer.invoke(IPC_CHANNELS.rolesDelete, id),
  getRolePaths: (id) => ipcRenderer.invoke(IPC_CHANNELS.rolesPaths, id),
  startLogin: (id) => ipcRenderer.invoke(IPC_CHANNELS.rolesStartLogin, id),
  listAuthStatuses: () => ipcRenderer.invoke(IPC_CHANNELS.rolesAuthStatuses),
  launchRole: (id) => ipcRenderer.invoke(IPC_CHANNELS.rolesLaunch, id),
  openSystemLoginWindow: (id) => ipcRenderer.invoke(IPC_CHANNELS.rolesOpenSystemLogin, id),
  stopRole: (id) => ipcRenderer.invoke(IPC_CHANNELS.rolesStop, id),
  listRoleStatuses: () => ipcRenderer.invoke(IPC_CHANNELS.rolesStatuses),
  listLaunchWorkspaces: () => ipcRenderer.invoke(IPC_CHANNELS.workspacesList),
  createLaunchWorkspace: (input) => ipcRenderer.invoke(IPC_CHANNELS.workspacesCreate, input),
  updateLaunchWorkspace: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.workspacesUpdate, id, input),
  reorderLaunchWorkspaces: (input) => ipcRenderer.invoke(IPC_CHANNELS.workspacesReorder, input),
  deleteLaunchWorkspace: (id) => ipcRenderer.invoke(IPC_CHANNELS.workspacesDelete, id),
  launchWorkspace: (id) => ipcRenderer.invoke(IPC_CHANNELS.workspacesLaunch, id),
  stopLaunchWorkspace: (id) => ipcRenderer.invoke(IPC_CHANNELS.workspacesStop, id),
  listMacros: () => ipcRenderer.invoke(IPC_CHANNELS.macrosList),
  createMacro: (input) => ipcRenderer.invoke(IPC_CHANNELS.macrosCreate, input),
  updateMacro: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.macrosUpdate, id, input),
  deleteMacro: (id) => ipcRenderer.invoke(IPC_CHANNELS.macrosDelete, id),
  startMacro: (macroId) => ipcRenderer.invoke(IPC_CHANNELS.macrosStart, macroId),
  stopMacro: (macroId) => ipcRenderer.invoke(IPC_CHANNELS.macrosStop, macroId),
  listMacroStatuses: () => ipcRenderer.invoke(IPC_CHANNELS.macrosStatuses),
  exportPortableData: (input) => ipcRenderer.invoke(IPC_CHANNELS.portableExport, input),
  previewPortableImport: () => ipcRenderer.invoke(IPC_CHANNELS.portableImportPreview),
  applyPortableImport: (importId) => ipcRenderer.invoke(IPC_CHANNELS.portableImportApply, importId),
  getGameBrowserSettings: () => ipcRenderer.invoke(IPC_CHANNELS.gameBrowserSettingsGet),
  updateGameBrowserSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.gameBrowserSettingsUpdate, settings),
  listSystemFonts: () => ipcRenderer.invoke(IPC_CHANNELS.systemFontsList),
  consumePendingMacroEditorRequest: () => ipcRenderer.invoke(IPC_CHANNELS.macrosConsumeEditorRequest),
  setOverlayLanguage: (language) => ipcRenderer.invoke(IPC_CHANNELS.preferencesSetOverlayLanguage, language),
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appVersion),
  getUpdateStatus: () => ipcRenderer.invoke(IPC_CHANNELS.updatesStatus),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.updatesCheck),
  openUpdateDownload: () => ipcRenderer.invoke(IPC_CHANNELS.updatesOpenDownload),
  installDownloadedUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.updatesInstall),
  onRoleStatusChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, statuses: RoleStatus[]) => {
      callback(statuses);
    };

    ipcRenderer.on(IPC_CHANNELS.rolesStatusChanged, listener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.rolesStatusChanged, listener);
    };
  },
  onAuthStatusChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, statuses: AuthFlowStatus[]) => {
      callback(statuses);
    };

    ipcRenderer.on(IPC_CHANNELS.rolesAuthStatusChanged, listener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.rolesAuthStatusChanged, listener);
    };
  },
  onMacroStatusChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, statuses: MacroRunStatus[]) => {
      callback(statuses);
    };

    ipcRenderer.on(IPC_CHANNELS.macrosStatusChanged, listener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.macrosStatusChanged, listener);
    };
  },
  onMacroEditorRequested: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, request: MacroEditorRequest) => {
      callback(request);
    };

    ipcRenderer.on(IPC_CHANNELS.macrosEditorRequested, listener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.macrosEditorRequested, listener);
    };
  },
  onUpdateStatusChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: AppUpdateStatus) => {
      callback(status);
    };

    ipcRenderer.on(IPC_CHANNELS.updatesStatusChanged, listener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.updatesStatusChanged, listener);
    };
  }
};

contextBridge.exposeInMainWorld("rionStudio", api);
