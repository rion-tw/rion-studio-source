import { contextBridge, ipcRenderer } from "electron";

import { IPC_CHANNELS } from "../shared/ipc";
import type { RionStudioApi } from "../shared/api";
import type {
  AppUpdateStatus,
  AppWindowState,
  AuthFlowStatus,
  Game,
  GameCompatibilityReport,
  GameCompatibilityRunStatus,
  EmbeddedRuntimeState,
  LogEntry,
  LaunchWorkspace,
  Macro,
  MacroPageRequest,
  MacroRunStatus,
  MacroSettings,
  PendingWorkspaceLaunchRequest,
  RoleStatus,
  WorkspaceDisplayInfo
} from "../shared/types";

const api: RionStudioApi = {
  notifyAppReady: (state) => ipcRenderer.invoke(IPC_CHANNELS.appRendererReady, state),
  getAppSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.appSnapshot),
  getCurrentWindowState: () => ipcRenderer.invoke(IPC_CHANNELS.appWindowState),
  getLegalAcceptanceStatus: () => ipcRenderer.invoke(IPC_CHANNELS.legalStatus),
  acceptLegalDocuments: (input) => ipcRenderer.invoke(IPC_CHANNELS.legalAccept, input),
  quitApplication: () => ipcRenderer.invoke(IPC_CHANNELS.appQuit),
  requestCurrentWindowClose: () => ipcRenderer.send(IPC_CHANNELS.appWindowClose),
  restartApplication: () => ipcRenderer.invoke(IPC_CHANNELS.appRestart),
  getEmbeddedRuntimeState: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeState),
  showEmbeddedRuntimeWindows: (displayId) => ipcRenderer.invoke(IPC_CHANNELS.runtimeShowWindows, displayId),
  showEmbeddedRuntimeTab: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.runtimeShowTab, tabId),
  moveEmbeddedRuntimeTab: (tabId, displayId) => ipcRenderer.invoke(IPC_CHANNELS.runtimeMoveTab, tabId, displayId),
  listGames: () => ipcRenderer.invoke(IPC_CHANNELS.gamesList),
  createGame: (input) => ipcRenderer.invoke(IPC_CHANNELS.gamesCreate, input),
  updateGame: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.gamesUpdate, id, input),
  resetBuiltinGame: (id) => ipcRenderer.invoke(IPC_CHANNELS.gamesResetBuiltin, id),
  deleteGame: (id) => ipcRenderer.invoke(IPC_CHANNELS.gamesDelete, id),
  deleteGames: (input) => ipcRenderer.invoke(IPC_CHANNELS.gamesDeleteMany, input),
  listGameCompatibilityReports: () => ipcRenderer.invoke(IPC_CHANNELS.gamesCompatibilityList),
  runGameCompatibilityCheck: (id) => ipcRenderer.invoke(IPC_CHANNELS.gamesCompatibilityRun, id),
  cancelGameCompatibilityCheck: (id) => ipcRenderer.invoke(IPC_CHANNELS.gamesCompatibilityCancel, id),
  listRoles: () => ipcRenderer.invoke(IPC_CHANNELS.rolesList),
  createRole: (input) => ipcRenderer.invoke(IPC_CHANNELS.rolesCreate, input),
  updateRole: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.rolesUpdate, id, input),
  reorderRoles: (input) => ipcRenderer.invoke(IPC_CHANNELS.rolesReorder, input),
  deleteRole: (id) => ipcRenderer.invoke(IPC_CHANNELS.rolesDelete, id),
  deleteRoles: (input) => ipcRenderer.invoke(IPC_CHANNELS.rolesDeleteMany, input),
  clearRoleBrowserData: (id) => ipcRenderer.invoke(IPC_CHANNELS.rolesClearBrowserData, id),
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
  deleteLaunchWorkspaces: (input) => ipcRenderer.invoke(IPC_CHANNELS.workspacesDeleteMany, input),
  listWorkspaceDisplays: () => ipcRenderer.invoke(IPC_CHANNELS.workspacesDisplays),
  launchWorkspace: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.workspacesLaunch, id, input),
  stopLaunchWorkspace: (id) => ipcRenderer.invoke(IPC_CHANNELS.workspacesStop, id),
  consumePendingWorkspaceLaunchRequest: () =>
    ipcRenderer.invoke(IPC_CHANNELS.workspacesConsumeLaunchRequest),
  listMacros: () => ipcRenderer.invoke(IPC_CHANNELS.macrosList),
  createMacro: (input) => ipcRenderer.invoke(IPC_CHANNELS.macrosCreate, input),
  updateMacro: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.macrosUpdate, id, input),
  deleteMacro: (id) => ipcRenderer.invoke(IPC_CHANNELS.macrosDelete, id),
  deleteMacros: (input) => ipcRenderer.invoke(IPC_CHANNELS.macrosDeleteMany, input),
  startMacro: (macroId) => ipcRenderer.invoke(IPC_CHANNELS.macrosStart, macroId),
  stopMacro: (macroId) => ipcRenderer.invoke(IPC_CHANNELS.macrosStop, macroId),
  listMacroStatuses: () => ipcRenderer.invoke(IPC_CHANNELS.macrosStatuses),
  getMacroSettings: () => ipcRenderer.invoke(IPC_CHANNELS.macroSettingsGet),
  updateMacroSettings: (settings: MacroSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.macroSettingsUpdate, settings),
  exportPortableData: (input) => ipcRenderer.invoke(IPC_CHANNELS.portableExport, input),
  previewPortableImport: () => ipcRenderer.invoke(IPC_CHANNELS.portableImportPreview),
  applyPortableImport: (input) => ipcRenderer.invoke(IPC_CHANNELS.portableImportApply, input),
  discardPortableImport: (importId) => ipcRenderer.invoke(IPC_CHANNELS.portableImportDiscard, importId),
  previewChromeProfileImport: () => ipcRenderer.invoke(IPC_CHANNELS.chromeProfileImportPreview),
  closeChromeForImport: () => ipcRenderer.invoke(IPC_CHANNELS.chromeProfileImportCloseChrome),
  applyChromeProfileImport: (input) => ipcRenderer.invoke(IPC_CHANNELS.chromeProfileImportApply, input),
  discardChromeProfileImport: (importId) => ipcRenderer.invoke(IPC_CHANNELS.chromeProfileImportDiscard, importId),
  getGameBrowserSettings: () => ipcRenderer.invoke(IPC_CHANNELS.gameBrowserSettingsGet),
  updateGameBrowserSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.gameBrowserSettingsUpdate, settings),
  getGraphicsDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.graphicsDiagnosticsGet),
  getLogStatus: () => ipcRenderer.invoke(IPC_CHANNELS.logsStatus),
  queryLogs: (query) => ipcRenderer.invoke(IPC_CHANNELS.logsQuery, query),
  setLogLevel: (level) => ipcRenderer.invoke(IPC_CHANNELS.logsSetLevel, level),
  clearLogs: () => ipcRenderer.invoke(IPC_CHANNELS.logsClear),
  revealLogs: () => ipcRenderer.invoke(IPC_CHANNELS.logsReveal),
  exportDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.logsExport),
  reportRendererLog: (event) => ipcRenderer.send(IPC_CHANNELS.logsRendererEvent, event),
  listSystemFonts: () => ipcRenderer.invoke(IPC_CHANNELS.systemFontsList),
  consumePendingMacroPageRequest: () => ipcRenderer.invoke(IPC_CHANNELS.macrosConsumePageRequest),
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
  onCurrentWindowStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppWindowState) => callback(state);
    ipcRenderer.on(IPC_CHANNELS.appWindowStateChanged, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.appWindowStateChanged, listener);
  },
  onEmbeddedRuntimeStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: EmbeddedRuntimeState) => callback(state);
    ipcRenderer.on(IPC_CHANNELS.runtimeStateChanged, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.runtimeStateChanged, listener);
  },
  onGamesChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, games: Game[]) => callback(games);
    ipcRenderer.on(IPC_CHANNELS.gamesChanged, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.gamesChanged, listener);
  },
  onWorkspacesChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, workspaces: LaunchWorkspace[]) => {
      callback(workspaces);
    };
    ipcRenderer.on(IPC_CHANNELS.workspacesChanged, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.workspacesChanged, listener);
  },
  onGameCompatibilityChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      reports: GameCompatibilityReport[],
      statuses: GameCompatibilityRunStatus[]
    ) => callback(reports, statuses);
    ipcRenderer.on(IPC_CHANNELS.gamesCompatibilityChanged, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.gamesCompatibilityChanged, listener);
  },
  onWorkspaceDisplaysChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, displays: WorkspaceDisplayInfo[]) => {
      callback(displays);
    };

    ipcRenderer.on(IPC_CHANNELS.workspacesDisplaysChanged, listener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.workspacesDisplaysChanged, listener);
    };
  },
  onWorkspaceLaunchRequested: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, request: PendingWorkspaceLaunchRequest) => {
      callback(request);
    };

    ipcRenderer.on(IPC_CHANNELS.workspacesLaunchRequested, listener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.workspacesLaunchRequested, listener);
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
  onMacrosChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, macros: Macro[]) => callback(macros);
    ipcRenderer.on(IPC_CHANNELS.macrosChanged, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.macrosChanged, listener);
  },
  onMacroPageRequested: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, request: MacroPageRequest) => {
      callback(request);
    };

    ipcRenderer.on(IPC_CHANNELS.macrosPageRequested, listener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.macrosPageRequested, listener);
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
  },
  onLogEntryAdded: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: LogEntry) => callback(entry);
    ipcRenderer.on(IPC_CHANNELS.logsEntryAdded, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.logsEntryAdded, listener);
  }
};

contextBridge.exposeInMainWorld("rionStudio", api);
