import type { RionStudioApi } from "../../shared/api";

type ApiMethod = keyof RionStudioApi;
type EventMethod = {
  [Method in ApiMethod]: RionStudioApi[Method] extends (...args: infer _Args) => infer Result
    ? Result extends () => void
      ? Method
      : never
    : never;
}[ApiMethod];

export type RionApiEventMethod = EventMethod;
export type RionApiNotifyMethod = "reportRendererLog";
export type RionApiInvokeMethod = Exclude<
  ApiMethod,
  RionApiEventMethod | RionApiNotifyMethod
>;
export type RionApiDispatchMethod = RionApiInvokeMethod | RionApiNotifyMethod;

export type RionApiArgs<Method extends ApiMethod> =
  RionStudioApi[Method] extends (...args: infer Args) => unknown ? Args : never;
export type RionApiResult<Method extends ApiMethod> =
  RionStudioApi[Method] extends (...args: infer _Args) => infer Result
    ? Awaited<Result>
    : never;
export type RionApiEventPayload<Method extends RionApiEventMethod> =
  RionStudioApi[Method] extends (callback: infer Callback, ...args: infer _Rest) => () => void
    ? Callback extends (...payload: infer Payload) => void
      ? Payload
      : never
    : never;

export const RION_API_INVOKE_METHODS = {
  notifyRendererReady: true,
  getAppSnapshot: true,
  getCurrentWindowState: true,
  getApplicationLifecycleStatus: true,
  getLegalAcceptanceStatus: true,
  acceptLegalDocuments: true,
  quitApplication: true,
  confirmApplicationQuit: true,
  requestCurrentWindowClose: true,
  minimizeCurrentWindow: true,
  startCurrentWindowDrag: true,
  toggleCurrentWindowMaximize: true,
  executeApplicationShortcut: true,
  getEmbeddedRuntimeState: true,
  listGameWindows: true,
  createGameWindow: true,
  updateGameWindow: true,
  reorderGameWindows: true,
  showGameWindow: true,
  hideGameWindow: true,
  stopGameWindow: true,
  deleteGameWindow: true,
  showGameWindowTab: true,
  moveGameWindowTab: true,
  moveGameWindowTabToNewWindow: true,
  reorderGameWindowTab: true,
  setGameWindowTabMuted: true,
  setGameWindowTabHidden: true,
  stopGameWindowTab: true,
  restoreSavedGameWindows: true,
  discardSavedGameWindows: true,
  getRuntimeWindowPreferences: true,
  updateRuntimeWindowPreferences: true,
  setQuickAccessPinned: true,
  recordQuickAccessUse: true,
  clearQuickAccessRecent: true,
  consumePendingQuickAccessRequest: true,
  presentQuickAccessRequest: true,
  resolveQuickAccessRequest: true,
  listGames: true,
  createGame: true,
  updateGame: true,
  resetBuiltinGame: true,
  deleteGame: true,
  deleteGames: true,
  listRoles: true,
  createRole: true,
  updateRole: true,
  reorderRoles: true,
  deleteRole: true,
  deleteRoles: true,
  clearRoleBrowserData: true,
  clearGlobalWebProfile: true,
  getRolePaths: true,
  launchRole: true,
  stopRole: true,
  listRoleStatuses: true,
  listLaunchWorkspaces: true,
  createLaunchWorkspace: true,
  updateLaunchWorkspace: true,
  reorderLaunchWorkspaces: true,
  deleteLaunchWorkspace: true,
  deleteLaunchWorkspaces: true,
  getDisplayTopology: true,
  launchWorkspace: true,
  stopLaunchWorkspace: true,
  listMacros: true,
  createMacro: true,
  updateMacro: true,
  deleteMacro: true,
  deleteMacros: true,
  startMacro: true,
  stopMacro: true,
  listMacroStatuses: true,
  getMacroSettings: true,
  updateMacroSettings: true,
  exportPortableData: true,
  previewPortableImport: true,
  applyPortableImport: true,
  discardPortableImport: true,
  previewChromeProfileImport: true,
  requestChromeQuitForImport: true,
  applyChromeProfileImport: true,
  discardChromeProfileImport: true,
  getGameBrowserSettings: true,
  updateGameBrowserSettings: true,
  patchGameBrowserSettings: true,
  listBrowserFontCatalog: true,
  installBrowserFont: true,
  installGoogleFont: true,
  removeBrowserFont: true,
  getBrowserFontPreview: true,
  getLogStatus: true,
  queryLogs: true,
  setLogLevel: true,
  clearLogs: true,
  revealLogs: true,
  beginBrowserPerformanceDiagnostics: true,
  cancelBrowserPerformanceDiagnostics: true,
  exportDiagnostics: true,
  listSystemFonts: true,
  consumePendingMacroPageRequest: true,
  setOverlayLanguage: true,
  setRuntimeTheme: true,
  getAppVersion: true,
  getUpdateStatus: true,
  checkForUpdates: true,
  setAutoUpdateEnabled: true,
  openUpdateDownload: true,
  installDownloadedUpdate: true
} as const satisfies Record<RionApiInvokeMethod, true>;

export const RION_API_NOTIFY_METHODS = {
  reportRendererLog: true
} as const satisfies Record<RionApiNotifyMethod, true>;

export const RION_API_EVENT_METHODS = {
  onRoleStatusChanged: true,
  onAppSnapshotChanged: true,
  onApplicationQuitRequested: true,
  onCurrentWindowStateChanged: true,
  onApplicationLifecycleChanged: true,
  onEmbeddedRuntimeStateChanged: true,
  onWindowLifecycleChanged: true,
  onSurfaceRecoveryAttemptChanged: true,
  onGamesChanged: true,
  onRolesChanged: true,
  onGameWindowsChanged: true,
  onWorkspacesChanged: true,
  onDisplayTopologyChanged: true,
  onMacroStatusChanged: true,
  onMacrosChanged: true,
  onMacroPageRequested: true,
  onQuickAccessRequested: true,
  onUpdateStatusChanged: true,
  onShellError: true,
  onLogEntryAdded: true,
  onChromeProfileImportProgress: true,
  onBrowserPerformanceDiagnosticsChanged: true
} as const satisfies Record<RionApiEventMethod, true>;

export function isRionApiInvokeMethod(value: unknown): value is RionApiInvokeMethod {
  return typeof value === "string" && Object.hasOwn(RION_API_INVOKE_METHODS, value);
}

export function isRionApiNotifyMethod(value: unknown): value is RionApiNotifyMethod {
  return typeof value === "string" && Object.hasOwn(RION_API_NOTIFY_METHODS, value);
}

export function isRionApiEventMethod(value: unknown): value is RionApiEventMethod {
  return typeof value === "string" && Object.hasOwn(RION_API_EVENT_METHODS, value);
}
