import { BrowserWindow, ipcMain } from "electron";

import { IPC_CHANNELS } from "../../shared/ipc";
import type {
  AcceptLegalDocumentsInput,
  AppLanguage,
  AppRendererReadyState,
  AppUpdateStatus,
  AuthFlowStatus,
  BulkDeleteInput,
  BulkDeleteResult,
  BulkDeleteSkippedItem,
  CreateGameInput,
  CreateLaunchWorkspaceInput,
  CreateMacroInput,
  CreateRoleInput,
  GameBrowserSettings,
  MacroEditorRequest,
  MacroRunStatus,
  PortableExportInput,
  PortableImportInput,
  ReorderItemsInput,
  RoleDefaults,
  RoleStatus,
  UpdateLaunchWorkspaceInput,
  UpdateGameInput,
  UpdateMacroInput,
  UpdateRoleInput,
  WorkspaceDisplayInfo,
  WorkspaceDisplayLaunchOption,
  WorkspaceLaunchInput,
  WorkspaceLaunchResult
} from "../../shared/types";
import type { AuthManager } from "../auth/AuthManager";
import {
  BrowserWorkspaceDisplayOccupiedError,
  EXTERNAL_COMPAT_NOTICE,
  type BrowserManager
} from "../browser/BrowserManager";
import type { GameBrowserSettingsStore } from "../game-browser/GameBrowserSettingsStore";
import type { SystemFontService } from "../game-browser/SystemFontService";
import type { GameCompatibilityManager } from "../games/GameCompatibilityManager";
import type { GameStore } from "../games/GameStore";
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
  gameStore?: Pick<GameStore, "createGame" | "deleteGame" | "getGame" | "listGames" | "resetBuiltinGame" | "updateGame">;
  gameCompatibilityManager?: Pick<
    GameCompatibilityManager,
    "cancelCheck" | "deleteGame" | "listReports" | "listStatuses" | "on" | "recordObservation" | "runCheck"
  >;
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
  ipcMain.handle(IPC_CHANNELS.gamesCompatibilityRun, async (_event, id: string, fallbackRoleDefaults?: RoleDefaults) => {
    if (!options.gameCompatibilityManager) {
      throw new Error("Game compatibility checks are not available.");
    }
    return options.gameCompatibilityManager.runCheck(id, normalizeCompatibilityRoleDefaults(fallbackRoleDefaults));
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
      return savedSettings;
    })
  );

  ipcMain.handle(IPC_CHANNELS.graphicsDiagnosticsGet, (event) => {
    if (!options.getGraphicsDiagnostics) {
      throw new Error("Graphics diagnostics are not available.");
    }

    return options.getGraphicsDiagnostics(event.sender);
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
        launchUrl: input.launchUrl ?? game.defaultLaunchUrl,
        windowWidth: input.windowWidth ?? game.roleDefaults?.windowWidth,
        windowHeight: input.windowHeight ?? game.roleDefaults?.windowHeight,
        launchPreset: input.launchPreset ?? game.roleDefaults?.launchPreset
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
      await deleteRoleRecord(roleStore, workspaceStore, browserManager, options.macroStore, id);
      options.onRolesChanged?.();
      options.onWorkspacesChanged?.();
      options.onMacrosChanged?.();
    })
  );
  ipcMain.handle(IPC_CHANNELS.rolesDeleteMany, (_event, input: BulkDeleteInput) =>
    runDataMutation(options, async () => {
      const result = await runBulkDelete(input, (id) =>
        deleteRoleRecord(roleStore, workspaceStore, browserManager, options.macroStore, id)
      );
      if (result.deletedIds.length > 0) {
        options.onRolesChanged?.();
        options.onWorkspacesChanged?.();
        options.onMacrosChanged?.();
      }
      return result;
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
      await recordLaunchSuccess(options, role.gameId, status);
      return status;
    } catch (error) {
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
      const workspace = await runWithExistingRoles(
        getWorkspaceInputRoleIds(input),
        roleStore,
        browserManager,
        () => workspaceStore.createWorkspace(input)
      );
      options.onWorkspacesChanged?.();
      return workspace;
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.workspacesUpdate,
    (_event, id: string, input: UpdateLaunchWorkspaceInput) => runDataMutation(options, async () => {
      const workspace = await runWithExistingRoles(
        getWorkspaceInputRoleIds(input),
        roleStore,
        browserManager,
        () => workspaceStore.updateWorkspace(id, input)
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

  ipcMain.handle(IPC_CHANNELS.workspacesLaunch, async (_event, id: string, input?: WorkspaceLaunchInput) => {
    if (!isWorkspaceLaunchInput(input)) {
      throw new Error("Launch workspace display selection is invalid.");
    }

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

    const displays = getWorkspaceDisplays(options);
    const targetDisplayId =
      input?.displayId ??
      workspace.targetDisplayId ??
      options.getDefaultWorkspaceDisplayId?.() ??
      displays[0]?.id;
    const targetDisplay = displays.find((display) => display.id === targetDisplayId);
    const launchOptions = createWorkspaceDisplayLaunchOptions(displays, browserManager, workspace.id);

    if (!targetDisplay) {
      return {
        kind: "display_selection_required",
        reason: "target_unavailable",
        displays: launchOptions
      } satisfies WorkspaceLaunchResult;
    }

    if (launchOptions.find((display) => display.id === targetDisplay.id)?.occupiedByWorkspace) {
      return {
        kind: "display_selection_required",
        reason: "target_occupied",
        displays: launchOptions
      } satisfies WorkspaceLaunchResult;
    }

    try {
      const globalLaunchMode = options.gameBrowserSettingsStore
        ? (await options.gameBrowserSettingsStore.getSettings()).launchMode
        : "embedded";
      const workspaceLaunchMode = workspace.browserLaunchMode === "inherit"
        ? globalLaunchMode
        : workspace.browserLaunchMode;
      const statuses = await browserManager.launchWorkspace(
        workspace,
        launchItems.map(({ role, slot }) => ({ role, rect: slot.rect })),
        { displayId: targetDisplay.id, workArea: targetDisplay.workArea },
        workspaceLaunchMode
      );
      await Promise.all(statuses.map((status) => {
        const role = launchItems.find((item) => item.role.id === status.roleId)?.role;
        return role ? recordLaunchSuccess(options, role.gameId, status) : Promise.resolve();
      }));
      return {
        kind: "launched",
        displayId: targetDisplay.id,
        statuses
      } satisfies WorkspaceLaunchResult;
    } catch (error) {
      if (!(error instanceof BrowserWorkspaceDisplayOccupiedError)) {
        await Promise.all(
          [...new Set(launchItems.map((item) => item.role.gameId))]
            .map((gameId) => recordLaunchFailure(options, gameId, error))
        );
        throw error;
      }

      return {
        kind: "display_selection_required",
        reason: "target_occupied",
        displays: createWorkspaceDisplayLaunchOptions(getWorkspaceDisplays(options), browserManager, workspace.id)
      } satisfies WorkspaceLaunchResult;
    }
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
          () => macroManager.runStoppedMutation(id, () => macroStore.updateMacro(id, input))
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
        const result = await runBulkDelete(input, (id) => deleteMacroRecord(macroStore, macroManager, id));
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

function runDataMutation<T>(
  options: RegisterIpcHandlersOptions,
  operation: () => Promise<T>
): Promise<T> {
  return options.withDataMutation?.(operation) ?? operation();
}

async function deleteGameRecord(options: RegisterIpcHandlersOptions, id: string): Promise<void> {
  await requireGameStore(options).deleteGame(id);
  await options.gameCompatibilityManager?.deleteGame(id);
}

async function deleteRoleRecord(
  roleStore: RoleStore,
  workspaceStore: LaunchWorkspaceStore,
  browserManager: BrowserManager,
  macroStore: MacroStore | undefined,
  id: string
): Promise<void> {
  await browserManager.stopRoleAndRunMutation(id, async () => {
    await roleStore.deleteRole(id);
    await workspaceStore.clearRole(id);
    await macroStore?.deleteRoleMacros(id);
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
    ? error.details as { roleNames?: unknown }
    : undefined;
  const relatedNames = Array.isArray(details?.roleNames)
    ? details.roleNames.filter((name): name is string => typeof name === "string")
    : undefined;

  if (code === "GAME_BUILTIN_DELETE_FORBIDDEN") {
    return { id, reason: "protected" };
  }
  if (code === "GAME_IN_USE") {
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

function normalizeCompatibilityRoleDefaults(value: RoleDefaults | undefined): RoleDefaults {
  const defaults = value ?? { windowWidth: 1440, windowHeight: 900, launchPreset: "performance" as const };
  if (
    !Number.isInteger(defaults.windowWidth) || defaults.windowWidth < 640 || defaults.windowWidth > 7680 ||
    !Number.isInteger(defaults.windowHeight) || defaults.windowHeight < 640 || defaults.windowHeight > 7680 ||
    (defaults.launchPreset !== "balanced" && defaults.launchPreset !== "performance")
  ) {
    throw new Error("Compatibility role defaults are invalid.");
  }
  return defaults;
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

function hasPortableImportChanges(summary: { create: number; update: number }): boolean {
  return summary.create > 0 || summary.update > 0;
}

function createWorkspaceDisplayLaunchOptions(
  displays: WorkspaceDisplayInfo[],
  browserManager: BrowserManager,
  launchingWorkspaceId: string
): WorkspaceDisplayLaunchOption[] {
  const reservations = browserManager.listWorkspaceDisplayReservations?.() ?? [];
  const reservationByDisplayId = new Map(
    reservations
      .filter((reservation) => reservation.workspaceId !== launchingWorkspaceId)
      .map((reservation) => [reservation.displayId, reservation] as const)
  );

  return displays.map((display) => {
    const reservation = reservationByDisplayId.get(display.id);
    return {
      ...display,
      ...(reservation
        ? {
            occupiedByWorkspace: {
              id: reservation.workspaceId,
              name: reservation.workspaceName
            }
          }
        : {})
    };
  });
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

export function broadcastWorkspaceDisplaysChanged(displays: WorkspaceDisplayInfo[]): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.workspacesDisplaysChanged, displays);
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
