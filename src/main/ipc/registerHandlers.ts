import { BrowserWindow, ipcMain, type WebContents } from "electron";

import { IPC_CHANNELS } from "../../shared/ipc";
import { LOG_LEVELS } from "../../shared/types";
import type {
  AcceptLegalDocumentsInput,
  AppLanguage,
  AppRendererReadyState,
  AppUpdateStatus,
  EmbeddedRuntimeState,
  AuthFlowStatus,
  BulkDeleteInput,
  BulkDeleteResult,
  BulkDeleteSkippedItem,
  ChromeProfileImportInput,
  CreateGameInput,
  CreateLaunchWorkspaceInput,
  CreateMacroInput,
  CreateRoleInput,
  GameBrowserSettings,
  Macro,
  MacroPageRequest,
  MacroRunStatus,
  MacroSettings,
  PendingWorkspaceLaunchRequest,
  PortableExportInput,
  PortableImportInput,
  ReorderItemsInput,
  RoleStatus,
  UpdateLaunchWorkspaceInput,
  UpdateGameInput,
  UpdateMacroInput,
  UpdateRoleInput,
  WorkspaceDisplayInfo,
  LaunchWorkspace,
  WorkspaceLaunchInput,
  LogLevel,
  LogQuery,
  RendererLogEvent
} from "../../shared/types";
import {
  createWorkspaceDisplayTarget,
  resolveWorkspaceDisplayTarget
} from "../../shared/workspaceDisplays";
import type { AuthManager } from "../auth/AuthManager";
import {
  BrowserLaunchCancelledError,
  EXTERNAL_COMPAT_NOTICE,
  type BrowserManager
} from "../browser/BrowserManager";
import type { RoleBrowserDataManager } from "../browser/RoleBrowserDataManager";
import type { ChromeProfileImportManager } from "../browser/ChromeProfileImportManager";
import type { GameBrowserSettingsStore } from "../game-browser/GameBrowserSettingsStore";
import type { SystemFontService } from "../game-browser/SystemFontService";
import type { GameCompatibilityManager } from "../games/GameCompatibilityManager";
import type { GameStore } from "../games/GameStore";
import type { LegalAcceptanceStore } from "../legal/LegalAcceptanceStore";
import type { MacroManager } from "../macros/MacroManager";
import {
  isMacroOverlayRequest,
  type MacroOverlayRequest
} from "../macros/MacroOverlayInjector";
import type { MacroStore } from "../macros/MacroStore";
import type { MacroSettingsStore } from "../macros/MacroSettingsStore";
import type { PortableDataManager } from "../portable/PortableDataManager";
import { RoleStore } from "../roles/RoleStore";
import type { AppUpdateManager } from "../updates/AppUpdateManager";
import { LaunchWorkspaceStore } from "../workspaces/LaunchWorkspaceStore";
import { WorkspaceLaunchCoordinator } from "../workspaces/WorkspaceLaunchCoordinator";
import { getAppWindowState } from "../window/appWindowState";

interface RegisterIpcHandlersOptions {
  legalAcceptanceStore?: Pick<LegalAcceptanceStore, "accept" | "getStatus">;
  macroManager?: MacroManager;
  macroStore?: MacroStore;
  macroSettingsStore?: Pick<MacroSettingsStore, "getSettings" | "updateSettings">;
  gameBrowserSettingsStore?: Pick<GameBrowserSettingsStore, "getSettings" | "updateSettings">;
  gameStore?: Pick<GameStore, "createGame" | "deleteGame" | "getGame" | "listGames" | "resetBuiltinGame" | "updateGame">;
  gameCompatibilityManager?: Pick<
    GameCompatibilityManager,
    "cancelCheck" | "deleteGame" | "listReports" | "listStatuses" | "on" | "recordObservation" | "runCheck"
  >;
  systemFontService?: Pick<SystemFontService, "listFonts">;
  updateManager?: AppUpdateManager;
  consumePendingMacroPageRequest?: () => MacroPageRequest | null;
  consumePendingWorkspaceLaunchRequest?: () => PendingWorkspaceLaunchRequest | null;
  onGameBrowserSettingsChanged?: () => void;
  onMacrosChanged?: () => void;
  onMacroOverlayRequest?: (webContents: WebContents, request: MacroOverlayRequest) => Promise<unknown>;
  onOverlayLanguageChanged?: (language: AppLanguage) => void;
  onLegalAccepted?: () => void;
  onRendererReady?: (senderId: number, state: AppRendererReadyState) => void;
  clearRoleEmbeddedStorageSeed?: (roleId: string) => Promise<void>;
  onRolesChanged?: () => void;
  onWorkspacesChanged?: () => void;
  roleBrowserDataManager?: Pick<RoleBrowserDataManager, "clear">;
  chromeProfileImportManager?: Pick<
    ChromeProfileImportManager,
    "applyImport" | "closeChrome" | "discardImport" | "previewImport"
  >;
  workspaceLauncher?: Pick<WorkspaceLaunchCoordinator, "launch">;
  withDataMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
  getDefaultWorkspaceDisplayId?: () => number;
  getWorkspaceDisplays?: () => WorkspaceDisplayInfo[];
  portableDataManager?: Pick<
    PortableDataManager,
    "applyImport" | "discardImport" | "exportData" | "previewImport"
  >;
  getGraphicsDiagnostics?: (sender: Electron.WebContents) => Promise<unknown>;
  quitApplication?: () => void;
  restartApplication?: () => void;
  logService?: {
    clear: () => Promise<void>;
    getStatus: () => Promise<unknown>;
    query: (query?: LogQuery) => Promise<unknown>;
    setLevel: (level: LogLevel) => void;
    info: (source: "ipc", event: string, message: string, context?: Record<string, unknown>) => void;
    warn: (source: "renderer", event: string, message: string, context?: Record<string, unknown>, error?: unknown) => void;
    error: (source: "renderer" | "ipc", event: string, message: string, error?: unknown, context?: Record<string, unknown>) => void;
  };
  revealLogs?: () => Promise<void>;
  exportDiagnostics?: () => Promise<unknown>;
}

export function registerIpcHandlers(
  roleStore: RoleStore,
  workspaceStore: LaunchWorkspaceStore,
  browserManager: BrowserManager,
  authManager: AuthManager,
  options: RegisterIpcHandlersOptions = {}
): void {
  const workspaceLauncher = options.workspaceLauncher ?? new WorkspaceLaunchCoordinator({
    browserManager,
    gameBrowserSettingsStore: options.gameBrowserSettingsStore,
    gameCompatibilityManager: options.gameCompatibilityManager,
    getDefaultWorkspaceDisplayId: options.getDefaultWorkspaceDisplayId,
    getWorkspaceDisplays: options.getWorkspaceDisplays,
    roleStore,
    workspaceStore
  });
  browserManager.on("change", (statuses) => {
    broadcastStatusChange(statuses);
  });
  browserManager.on("runtimeChange", (state) => {
    broadcastRuntimeStateChange(state);
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
  options.gameCompatibilityManager?.on("change", () => {
    void broadcastGameCompatibilityChange(options);
  });

  ipcMain.handle(IPC_CHANNELS.appRendererReady, (event, state: AppRendererReadyState) => {
    if (!isAppRendererReadyState(state)) {
      throw new Error("Renderer readiness state is invalid.");
    }

    options.onRendererReady?.(event.sender.id, state);
  });

  ipcMain.handle(IPC_CHANNELS.appSnapshot, async () => {
    const [games, gameCompatibilityReports, roles, launchWorkspaces, macros] = await Promise.all([
      options.gameStore?.listGames() ?? Promise.resolve([]),
      options.gameCompatibilityManager?.listReports() ?? Promise.resolve([]),
      roleStore.listRoles(),
      workspaceStore.listWorkspaces(),
      options.macroStore?.listMacros() ?? Promise.resolve([])
    ]);

    return {
      embeddedRuntimeState: browserManager.listEmbeddedRuntimeState(),
      games,
      gameCompatibilityReports,
      gameCompatibilityStatuses: options.gameCompatibilityManager?.listStatuses() ?? [],
      roles,
      roleStatuses: browserManager.listStatuses(),
      authStatuses: authManager.listStatuses(),
      launchWorkspaces,
      workspaceDisplays: getWorkspaceDisplays(options),
      macros,
      macroStatuses: options.macroManager?.listStatuses() ?? []
    };
  });

  ipcMain.handle(IPC_CHANNELS.appWindowState, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      throw new Error("Current window is not available.");
    }
    return getAppWindowState(window);
  });

  ipcMain.handle(IPC_CHANNELS.runtimeState, () => browserManager.listEmbeddedRuntimeState());
  ipcMain.handle(IPC_CHANNELS.runtimeShowWindows, (_event, displayId?: number) => {
    if (displayId !== undefined && !Number.isInteger(displayId)) throw new Error("Display id is invalid.");
    return browserManager.showEmbeddedRuntimeWindows(displayId);
  });
  ipcMain.handle(IPC_CHANNELS.runtimeShowTab, (_event, tabId: string) => {
    if (typeof tabId !== "string" || !tabId) throw new Error("Runtime tab id is invalid.");
    return browserManager.showRuntimeTab(tabId);
  });
  ipcMain.handle(IPC_CHANNELS.runtimeMoveTab, (_event, tabId: string, displayId: number) => {
    if (typeof tabId !== "string" || !tabId || !Number.isInteger(displayId)) {
      throw new Error("Runtime tab move is invalid.");
    }
    return browserManager.moveRuntimeTab(tabId, displayId);
  });

  ipcMain.handle(IPC_CHANNELS.gamesList, () => requireGameStore(options).listGames());
  ipcMain.handle(IPC_CHANNELS.gamesCreate, (_event, input: CreateGameInput) =>
    runDataMutation(options, async () => {
      const game = await requireGameStore(options).createGame(input);
      await broadcastGamesChange(options);
      return game;
    })
  );
  ipcMain.handle(IPC_CHANNELS.gamesUpdate, (_event, id: string, input: UpdateGameInput) =>
    runDataMutation(options, async () => {
      const game = await requireGameStore(options).updateGame(id, input);
      await broadcastGamesChange(options);
      await broadcastGameCompatibilityChange(options);
      return game;
    })
  );
  ipcMain.handle(IPC_CHANNELS.gamesResetBuiltin, (_event, id: string) =>
    runDataMutation(options, async () => {
      const game = await requireGameStore(options).resetBuiltinGame(id);
      await broadcastGamesChange(options);
      await broadcastGameCompatibilityChange(options);
      return game;
    })
  );
  ipcMain.handle(IPC_CHANNELS.gamesDelete, (_event, id: string) =>
    runDataMutation(options, async () => {
      await deleteGameRecord(options, id);
      await broadcastGamesChange(options);
    })
  );
  ipcMain.handle(IPC_CHANNELS.gamesDeleteMany, (_event, input: BulkDeleteInput) =>
    runDataMutation(options, async () => {
      const result = await runBulkDelete(input, (id) => deleteGameRecord(options, id));
      if (result.deletedIds.length > 0) {
        await broadcastGamesChange(options);
      }
      return result;
    })
  );
  ipcMain.handle(IPC_CHANNELS.gamesCompatibilityList, () =>
    options.gameCompatibilityManager?.listReports() ?? Promise.resolve([])
  );
  ipcMain.handle(IPC_CHANNELS.gamesCompatibilityRun, async (_event, id: string) => {
    if (!options.gameCompatibilityManager) {
      throw new Error("Game compatibility checks are not available.");
    }
    return options.gameCompatibilityManager.runCheck(id);
  });
  ipcMain.handle(IPC_CHANNELS.gamesCompatibilityCancel, (_event, id: string) =>
    options.gameCompatibilityManager?.cancelCheck(id)
  );

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

  ipcMain.on(IPC_CHANNELS.appWindowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle(IPC_CHANNELS.appRestart, () => {
    if (!options.restartApplication) {
      throw new Error("Application restart is not available.");
    }
    if (browserManager.listStatuses().length > 0) {
      throw new Error("Stop all running roles before restarting Rion Studio.");
    }

    options.restartApplication();
  });

  ipcMain.handle(IPC_CHANNELS.preferencesSetOverlayLanguage, (_event, language: AppLanguage) => {
    if (!isAppLanguage(language)) {
      throw new Error("Language setting is invalid.");
    }

    options.onOverlayLanguageChanged?.(language);
  });

  ipcMain.handle(IPC_CHANNELS.macrosConsumePageRequest, () => options.consumePendingMacroPageRequest?.() ?? null);

  ipcMain.handle(IPC_CHANNELS.macrosOverlayRequest, (event, request: MacroOverlayRequest) => {
    if (!options.onMacroOverlayRequest || !isMacroOverlayRequest(request)) {
      throw new Error("Macro overlay request is invalid.");
    }

    return options.onMacroOverlayRequest(event.sender, request);
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

  ipcMain.handle(IPC_CHANNELS.portableImportApply, async (_event, input: PortableImportInput) => {
    if (!options.portableDataManager || !input || typeof input.importId !== "string" || !input.importId.trim()) {
      throw new Error("Portable data import is not available.");
    }

    const result = await options.portableDataManager.applyImport(input);
    if ((result.operations ? hasPortableImportChanges(result.operations.games) : result.gameCount > 0) && options.gameStore) {
      await broadcastGamesChange(options);
    }
    if (result.preferences?.gameBrowserSettings) {
      browserManager.setWorkspaceAppearanceSettings(result.preferences.gameBrowserSettings.workspace);
      await broadcastGameCompatibilityChange(options);
      options.onGameBrowserSettingsChanged?.();
    }
    if (result.operations ? hasPortableImportChanges(result.operations.roles) : result.roleCount > 0) {
      options.onRolesChanged?.();
    }
    if (
      result.operations
        ? hasPortableImportChanges(result.operations.launchWorkspaces)
        : result.workspaceCount > 0
    ) {
      options.onWorkspacesChanged?.();
    }
    if (result.operations ? hasPortableImportChanges(result.operations.macros) : result.macroCount > 0) {
      options.onMacrosChanged?.();
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.portableImportDiscard, (_event, importId: string) => {
    if (!options.portableDataManager || typeof importId !== "string" || !importId.trim()) {
      throw new Error("Portable data import is not available.");
    }
    options.portableDataManager.discardImport(importId);
  });

  ipcMain.handle(IPC_CHANNELS.chromeProfileImportPreview, () => {
    if (!options.chromeProfileImportManager) {
      throw new Error("Chrome profile import is not available.");
    }

    return options.chromeProfileImportManager.previewImport();
  });

  ipcMain.handle(IPC_CHANNELS.chromeProfileImportCloseChrome, () => {
    if (!options.chromeProfileImportManager) {
      throw new Error("Chrome profile import is not available.");
    }

    return options.chromeProfileImportManager.closeChrome();
  });

  ipcMain.handle(IPC_CHANNELS.chromeProfileImportApply, (event, input: ChromeProfileImportInput) => {
    if (
      !options.chromeProfileImportManager ||
      !input ||
      typeof input.importId !== "string" ||
      !input.importId.trim() ||
      !Array.isArray(input.profileIds) ||
      typeof input.gameId !== "string" ||
      !input.gameId.trim() ||
      input.consentAccepted !== true
    ) {
      throw new Error("Chrome profile import input is invalid.");
    }

    return runDataMutation(options, async () => {
      const result = await options.chromeProfileImportManager!.applyImport(input, (progress) => {
        const sender = event?.sender;
        if (sender && !sender.isDestroyed()) {
          sender.send(IPC_CHANNELS.chromeProfileImportProgress, progress);
        }
      });
      options.onRolesChanged?.();
      return result;
    });
  });

  ipcMain.handle(IPC_CHANNELS.chromeProfileImportDiscard, (_event, importId: string) => {
    if (!options.chromeProfileImportManager || typeof importId !== "string" || !importId.trim()) {
      throw new Error("Chrome profile import is not available.");
    }
    return options.chromeProfileImportManager.discardImport(importId);
  });

  ipcMain.handle(IPC_CHANNELS.gameBrowserSettingsGet, () => {
    if (!options.gameBrowserSettingsStore) {
      throw new Error("Game browser settings are not available.");
    }

    return options.gameBrowserSettingsStore.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.gameBrowserSettingsUpdate, (_event, settings: GameBrowserSettings) =>
    runDataMutation(options, async () => {
      if (!options.gameBrowserSettingsStore) {
        throw new Error("Game browser settings are not available.");
      }

      const savedSettings = await options.gameBrowserSettingsStore.updateSettings(settings);
      browserManager.setWorkspaceAppearanceSettings(savedSettings.workspace);
      await broadcastGameCompatibilityChange(options);
      options.onGameBrowserSettingsChanged?.();
      return savedSettings;
    })
  );

  ipcMain.handle(IPC_CHANNELS.macroSettingsGet, () => {
    if (!options.macroSettingsStore) {
      throw new Error("Macro settings are not available.");
    }

    return options.macroSettingsStore.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.macroSettingsUpdate, (_event, settings: MacroSettings) =>
    runDataMutation(options, async () => {
      if (!options.macroSettingsStore) {
        throw new Error("Macro settings are not available.");
      }

      return options.macroSettingsStore.updateSettings(settings);
    })
  );

  ipcMain.handle(IPC_CHANNELS.graphicsDiagnosticsGet, (event) => {
    if (!options.getGraphicsDiagnostics) {
      throw new Error("Graphics diagnostics are not available.");
    }

    return options.getGraphicsDiagnostics(event.sender);
  });

  ipcMain.handle(IPC_CHANNELS.logsStatus, () => {
    if (!options.logService) throw new Error("Application logs are not available.");
    return options.logService.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.logsQuery, (_event, query?: LogQuery) => {
    if (!options.logService) throw new Error("Application logs are not available.");
    return options.logService.query(query);
  });

  ipcMain.handle(IPC_CHANNELS.logsSetLevel, async (_event, level: LogLevel) => {
    if (!options.logService || !LOG_LEVELS.includes(level)) throw new Error("Invalid log level.");
    options.logService.setLevel(level);
    return options.logService.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.logsClear, async () => {
    if (!options.logService) throw new Error("Application logs are not available.");
    await options.logService.clear();
    return options.logService.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.logsReveal, () => {
    if (!options.revealLogs) throw new Error("Application logs are not available.");
    return options.revealLogs();
  });

  ipcMain.handle(IPC_CHANNELS.logsExport, () => {
    if (!options.exportDiagnostics) throw new Error("Diagnostic export is not available.");
    return options.exportDiagnostics();
  });

  ipcMain.on(IPC_CHANNELS.logsRendererEvent, (_event, value: unknown) => {
    if (!options.logService || !isRendererLogEvent(value)) return;
    const error = value.stack ? Object.assign(new Error(value.message), { stack: value.stack }) : undefined;
    if (value.event === "renderer_error") options.logService.error("renderer", value.event, value.message, error);
    else options.logService.warn("renderer", value.event, value.message, undefined, error);
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

  ipcMain.handle(IPC_CHANNELS.rolesCreate, (_event, input: CreateRoleInput) =>
    runDataMutation(options, async () => {
      const game = options.gameStore ? await options.gameStore.getGame(input.gameId) : undefined;
      const role = await roleStore.createRole(game ? {
        ...input,
        launchUrl: input.launchUrl ?? game.defaultLaunchUrl
      } : input);
      options.onRolesChanged?.();
      return role;
    })
  );

  ipcMain.handle(IPC_CHANNELS.rolesUpdate, (_event, id: string, input: UpdateRoleInput) =>
    runDataMutation(options, async () => {
      const current = await roleStore.getRole(id);
      if (input.gameId !== undefined && options.gameStore) {
        await options.gameStore.getGame(input.gameId);
      }
      const sessionIdentityChanged =
        (input.gameId !== undefined && input.gameId !== current.gameId) ||
        (input.launchUrl !== undefined && new URL(input.launchUrl).toString() !== current.launchUrl);
      const role = sessionIdentityChanged
        ? await browserManager.stopRoleAndRunMutation(id, () => roleStore.updateRole(id, input))
        : await roleStore.updateRole(id, input);
      options.onRolesChanged?.();
      return role;
    })
  );

  ipcMain.handle(IPC_CHANNELS.rolesReorder, (_event, input: ReorderItemsInput) =>
    runDataMutation(options, async () => {
      const roles = await roleStore.reorderRoles(input);
      options.onRolesChanged?.();
      return roles;
    })
  );

  ipcMain.handle(IPC_CHANNELS.rolesDelete, (_event, id: string) =>
    runDataMutation(options, async () => {
      await deleteRoleRecord(
        roleStore,
        workspaceStore,
        browserManager,
        options.macroStore,
        options.clearRoleEmbeddedStorageSeed,
        id
      );
      options.onRolesChanged?.();
      options.onWorkspacesChanged?.();
      options.onMacrosChanged?.();
    })
  );
  ipcMain.handle(IPC_CHANNELS.rolesDeleteMany, (_event, input: BulkDeleteInput) =>
    runDataMutation(options, async () => {
      const result = await runBulkDelete(input, (id) =>
        deleteRoleRecord(
          roleStore,
          workspaceStore,
          browserManager,
          options.macroStore,
          options.clearRoleEmbeddedStorageSeed,
          id
        )
      );
      if (result.deletedIds.length > 0) {
        options.onRolesChanged?.();
        options.onWorkspacesChanged?.();
        options.onMacrosChanged?.();
      }
      return result;
    })
  );

  ipcMain.handle(IPC_CHANNELS.rolesClearBrowserData, (_event, id: string) =>
    runDataMutation(options, async () => {
      const role = await requireRoleBrowserDataManager(options).clear(id);
      options.onRolesChanged?.();
      return role;
    })
  );

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

    try {
      const status = await browserManager.launch(role);
      if (status) await recordLaunchSuccess(options, role.gameId, status);
      return status;
    } catch (error) {
      if (error instanceof BrowserLaunchCancelledError) return null;
      await recordLaunchFailure(options, role.gameId, error);
      throw error;
    }
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

  ipcMain.handle(IPC_CHANNELS.workspacesCreate, (_event, input: CreateLaunchWorkspaceInput) =>
    runDataMutation(options, async () => {
      const normalizedInput = reconcileWorkspaceInputTargetDisplay(input, getWorkspaceDisplays(options));
      const workspace = await runWithExistingRoles(
        getWorkspaceInputRoleIds(normalizedInput),
        roleStore,
        browserManager,
        () => workspaceStore.createWorkspace(normalizedInput)
      );
      options.onWorkspacesChanged?.();
      return workspace;
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.workspacesUpdate,
    (_event, id: string, input: UpdateLaunchWorkspaceInput) => runDataMutation(options, async () => {
      const normalizedInput = reconcileWorkspaceInputTargetDisplay(input, getWorkspaceDisplays(options));
      const workspace = await runWithExistingRoles(
        getWorkspaceInputRoleIds(normalizedInput),
        roleStore,
        browserManager,
        () => workspaceStore.updateWorkspace(id, normalizedInput)
      );
      options.onWorkspacesChanged?.();
      return workspace;
    })
  );

  ipcMain.handle(IPC_CHANNELS.workspacesReorder, (_event, input: ReorderItemsInput) =>
    runDataMutation(options, async () => {
      const workspaces = await workspaceStore.reorderWorkspaces(input);
      options.onWorkspacesChanged?.();
      return workspaces;
    })
  );

  ipcMain.handle(IPC_CHANNELS.workspacesDelete, (_event, id: string) =>
    runDataMutation(options, async () => {
      await deleteWorkspaceRecord(workspaceStore, browserManager, id);
      options.onWorkspacesChanged?.();
    })
  );
  ipcMain.handle(IPC_CHANNELS.workspacesDeleteMany, (_event, input: BulkDeleteInput) =>
    runDataMutation(options, async () => {
      const result = await runBulkDelete(input, (id) =>
        deleteWorkspaceRecord(workspaceStore, browserManager, id)
      );
      if (result.deletedIds.length > 0) {
        options.onWorkspacesChanged?.();
      }
      return result;
    })
  );

  ipcMain.handle(IPC_CHANNELS.workspacesDisplays, () => getWorkspaceDisplays(options));

  ipcMain.handle(
    IPC_CHANNELS.workspacesConsumeLaunchRequest,
    () => options.consumePendingWorkspaceLaunchRequest?.() ?? null
  );

  ipcMain.handle(IPC_CHANNELS.workspacesLaunch, async (_event, id: string, input?: WorkspaceLaunchInput) => {
    if (!isWorkspaceLaunchInput(input)) {
      throw new Error("Launch workspace display selection is invalid.");
    }
    return workspaceLauncher.launch(id, input);
  });

  ipcMain.handle(IPC_CHANNELS.workspacesStop, async (_event, id: string) => {
    await browserManager.stopWorkspace(id);
  });

  if (options.macroStore && options.macroManager) {
    const { macroManager, macroStore } = options;

    ipcMain.handle(IPC_CHANNELS.macrosList, () => macroStore.listMacros());

    ipcMain.handle(IPC_CHANNELS.macrosCreate, (_event, input: CreateMacroInput) =>
      runDataMutation(options, async () => {
        const macro = await runWithExistingRoles(
          getMacroInputRoleIds(input),
          roleStore,
          browserManager,
          () => macroStore.createMacro(input)
        );
        options.onMacrosChanged?.();
        return macro;
      })
    );

    ipcMain.handle(IPC_CHANNELS.macrosUpdate, (_event, id: string, input: UpdateMacroInput) =>
      runDataMutation(options, async () => {
        const macro = await runWithExistingRoles(
          getMacroInputRoleIds(input),
          roleStore,
          browserManager,
          () => (input.enabled === false
            ? macroManager.stopAndRunMutation(id, () => macroStore.updateMacro(id, input))
            : macroManager.runStoppedMutation(id, () => macroStore.updateMacro(id, input)))
        );
        options.onMacrosChanged?.();
        return macro;
      })
    );

    ipcMain.handle(IPC_CHANNELS.macrosDelete, (_event, id: string) =>
      runDataMutation(options, async () => {
        await deleteMacroRecord(macroStore, macroManager, id);
        options.onMacrosChanged?.();
      })
    );
    ipcMain.handle(IPC_CHANNELS.macrosDeleteMany, (_event, input: BulkDeleteInput) =>
      runDataMutation(options, async () => {
        const ids = normalizeBulkDeleteIds(input);
        const result = await macroManager.stopAndRunMutations(ids, () => macroStore.deleteMacros(ids));
        if (result.deletedIds.length > 0) {
          options.onMacrosChanged?.();
        }
        return result;
      })
    );

    ipcMain.handle(IPC_CHANNELS.macrosStart, async (_event, macroId: string) => {
      return macroManager.start(macroId);
    });

    ipcMain.handle(IPC_CHANNELS.macrosStop, async (_event, macroId: string) => {
      await macroManager.stop(macroId);
    });

    ipcMain.handle(IPC_CHANNELS.macrosStatuses, () => macroManager.listStatuses());
  }
}

function isRendererLogEvent(value: unknown): value is RendererLogEvent {
  return Boolean(value && typeof value === "object" &&
    "event" in value && (value.event === "renderer_error" || value.event === "unhandled_rejection") &&
    "message" in value && typeof value.message === "string" && value.message.length > 0 && value.message.length <= 4_000 &&
    (!("stack" in value) || value.stack === undefined || (typeof value.stack === "string" && value.stack.length <= 20_000)));
}

function runDataMutation<T>(
  options: RegisterIpcHandlersOptions,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  const result = options.withDataMutation?.(operation) ?? operation();
  return result.then((value) => {
    options.logService?.info("ipc", "data_mutation_completed", "An IPC data mutation completed.", {
      durationMs: Date.now() - startedAt
    });
    return value;
  }).catch((error) => {
    options.logService?.error("ipc", "data_mutation_failed", "An IPC data mutation failed.", error, {
      durationMs: Date.now() - startedAt
    });
    throw error;
  });
}

async function deleteGameRecord(options: RegisterIpcHandlersOptions, id: string): Promise<void> {
  await requireGameStore(options).deleteGame(id);
  await options.gameCompatibilityManager?.deleteGame(id);
}

function requireRoleBrowserDataManager(
  options: RegisterIpcHandlersOptions
): Pick<RoleBrowserDataManager, "clear"> {
  if (!options.roleBrowserDataManager) {
    throw new Error("Role browser data clearing is not available.");
  }
  return options.roleBrowserDataManager;
}

async function deleteRoleRecord(
  roleStore: RoleStore,
  workspaceStore: LaunchWorkspaceStore,
  browserManager: BrowserManager,
  macroStore: MacroStore | undefined,
  clearRoleEmbeddedStorageSeed: ((roleId: string) => Promise<void>) | undefined,
  id: string
): Promise<void> {
  await browserManager.stopRoleAndRunMutation(id, async () => {
    browserManager.clearEmbeddedDocumentStorageSeed(id);
    await clearRoleEmbeddedStorageSeed?.(id);
    await roleStore.deleteRole(id);
    await workspaceStore.clearRole(id);
    await macroStore?.clearRoleAssignment(id);
  });
}

async function deleteWorkspaceRecord(
  workspaceStore: LaunchWorkspaceStore,
  browserManager: BrowserManager,
  id: string
): Promise<void> {
  await browserManager.stopWorkspace(id);
  await workspaceStore.deleteWorkspace(id);
}

async function deleteMacroRecord(macroStore: MacroStore, macroManager: MacroManager, id: string): Promise<void> {
  await macroManager.stopAndRunMutation(id, () => macroStore.deleteMacro(id));
}

async function runBulkDelete(
  input: BulkDeleteInput,
  operation: (id: string) => Promise<void>
): Promise<BulkDeleteResult> {
  const ids = normalizeBulkDeleteIds(input);
  const result: BulkDeleteResult = { deletedIds: [], skipped: [] };

  for (const id of ids) {
    try {
      await operation(id);
      result.deletedIds.push(id);
    } catch (error) {
      result.skipped.push(classifyBulkDeleteError(id, error));
    }
  }

  return result;
}

function normalizeBulkDeleteIds(input: BulkDeleteInput): string[] {
  if (!input || !Array.isArray(input.ids)) {
    throw new Error("Bulk delete input is invalid.");
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of input.ids) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("Bulk delete input is invalid.");
    }
    const id = value.trim();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function classifyBulkDeleteError(id: string, error: unknown): BulkDeleteSkippedItem {
  const code = readErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const details = error && typeof error === "object" && "details" in error
    ? error.details as { relatedNames?: unknown; roleNames?: unknown }
    : undefined;
  const rawRelatedNames = details?.relatedNames ?? details?.roleNames;
  const relatedNames = Array.isArray(rawRelatedNames)
    ? rawRelatedNames.filter((name): name is string => typeof name === "string")
    : undefined;

  if (code === "GAME_BUILTIN_DELETE_FORBIDDEN") {
    return { id, reason: "protected" };
  }
  if (code === "GAME_IN_USE" || code === "MACRO_IN_USE") {
    return { id, reason: "in_use", ...(relatedNames?.length ? { relatedNames } : {}) };
  }
  if (code.endsWith("_NOT_FOUND") || /not found/i.test(message)) {
    return { id, reason: "not_found" };
  }
  if (/busy|in progress|launching|stopping/i.test(message)) {
    return { id, reason: "busy" };
  }
  return { id, reason: "failed" };
}

async function runWithExistingRoles<T>(
  roleIds: string[],
  roleStore: RoleStore,
  browserManager: BrowserManager,
  operation: () => Promise<T>
): Promise<T> {
  const uniqueRoleIds = [...new Set(roleIds)];

  return browserManager.runRoleOperation(uniqueRoleIds, async () => {
    await Promise.all(uniqueRoleIds.map((roleId) => roleStore.getRole(roleId)));
    return operation();
  });
}

function getWorkspaceInputRoleIds(input: CreateLaunchWorkspaceInput | UpdateLaunchWorkspaceInput): string[] {
  if (!Array.isArray(input?.slots)) {
    return [];
  }

  return input.slots.flatMap((slot) =>
    slot && typeof slot.roleId === "string" && slot.roleId ? [slot.roleId] : []
  );
}

function getMacroInputRoleIds(input: CreateMacroInput | UpdateMacroInput): string[] {
  if (!Array.isArray(input?.roleIds)) {
    return [];
  }

  return input.roleIds.filter((roleId): roleId is string => typeof roleId === "string" && Boolean(roleId));
}

function isAppRendererReadyState(value: unknown): value is AppRendererReadyState {
  return value === "ready" || value === "failed";
}

function isWorkspaceLaunchInput(value: unknown): value is WorkspaceLaunchInput | undefined {
  if (value === undefined) {
    return true;
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  const input = value as { displayId?: unknown };
  return (
    input.displayId === undefined ||
    (typeof input.displayId === "number" && Number.isSafeInteger(input.displayId) && input.displayId !== -1)
  );
}

function getWorkspaceDisplays(options: RegisterIpcHandlersOptions): WorkspaceDisplayInfo[] {
  return options.getWorkspaceDisplays?.() ?? [
    {
      id: 0,
      label: "",
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
      workArea: { x: 0, y: 0, width: 1200, height: 800 },
      resolution: { width: 1200, height: 800 },
      scaleFactor: 1,
      isPrimary: true,
      isInternal: false
    }
  ];
}

function reconcileWorkspaceInputTargetDisplay<T extends UpdateLaunchWorkspaceInput>(
  input: T,
  displays: WorkspaceDisplayInfo[]
): T {
  if (!input.targetDisplay) {
    return input;
  }
  const resolvedDisplay = resolveWorkspaceDisplayTarget(input.targetDisplay, displays);
  return resolvedDisplay
    ? { ...input, targetDisplay: createWorkspaceDisplayTarget(resolvedDisplay) }
    : input;
}

function hasPortableImportChanges(summary: { create: number; update: number }): boolean {
  return summary.create > 0 || summary.update > 0;
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

function broadcastRuntimeStateChange(state: EmbeddedRuntimeState): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.runtimeStateChanged, state);
  });
}

export function broadcastWorkspaceDisplaysChanged(displays: WorkspaceDisplayInfo[]): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.workspacesDisplaysChanged, displays);
  });
}

export function broadcastWorkspacesChanged(workspaces: LaunchWorkspace[]): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.workspacesChanged, workspaces);
  });
}

export function broadcastMacrosChanged(macros: Macro[]): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.macrosChanged, macros);
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

function requireGameStore(options: RegisterIpcHandlersOptions): NonNullable<RegisterIpcHandlersOptions["gameStore"]> {
  if (!options.gameStore) {
    throw new Error("Game library is not available.");
  }
  return options.gameStore;
}

async function broadcastGamesChange(options: RegisterIpcHandlersOptions): Promise<void> {
  const games = await requireGameStore(options).listGames();
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.gamesChanged, games);
  });
}

async function broadcastGameCompatibilityChange(options: RegisterIpcHandlersOptions): Promise<void> {
  if (!options.gameCompatibilityManager) {
    return;
  }
  const reports = await options.gameCompatibilityManager.listReports();
  const statuses = options.gameCompatibilityManager.listStatuses();
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.gamesCompatibilityChanged, reports, statuses);
  });
}

async function recordLaunchSuccess(
  options: RegisterIpcHandlersOptions,
  gameId: string,
  status: RoleStatus
): Promise<void> {
  if (!options.gameCompatibilityManager) {
    return;
  }
  const timestamp = new Date().toISOString();
  await options.gameCompatibilityManager.recordObservation(gameId, status.runtimeMode === "external"
    ? {
        lastExternalSuccessAt: timestamp,
        ...(status.notice?.includes(EXTERNAL_COMPAT_NOTICE) ? { lastFallbackAt: timestamp } : {})
      }
    : { lastEmbeddedSuccessAt: timestamp });
}

async function recordLaunchFailure(
  options: RegisterIpcHandlersOptions,
  gameId: string,
  error: unknown
): Promise<void> {
  if (!options.gameCompatibilityManager) {
    return;
  }
  await options.gameCompatibilityManager.recordObservation(gameId, {
    lastLaunchFailureAt: new Date().toISOString(),
    lastLaunchFailureCode: readErrorCode(error)
  });
}

function readErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return "LAUNCH_FAILED";
}
