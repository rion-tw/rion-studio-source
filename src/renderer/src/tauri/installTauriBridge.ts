import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { RionStudioApi } from "../../../shared/api";
import {
  toMacroCreateInput,
  toMacroUpdateInput,
  toWorkspaceCreateInput,
  toWorkspaceUpdateInput
} from "../../../shared/domainInputs";
import type {
  CoreCommand,
  CoreCommandResult,
  CoreEvent
} from "../../../shared/generated";
import type {
  CreateGameInput,
  CreateRoleInput,
  MacroRunStatus,
  RendererLogEvent,
  UpdateGameInput,
  UpdateRoleInput
} from "../../../shared/types";
import { withTimeout } from "../app/withTimeout";

type Listener = (...payload: never[]) => void;
type Unlisten = () => void;
type ListenerRegistration = () => Promise<Unlisten>;

export const TAURI_BRIDGE_TIMEOUT_MS = 10_000;

export async function registerBridgeListeners(
  registrations: ListenerRegistration[],
  timeoutMs = TAURI_BRIDGE_TIMEOUT_MS
): Promise<Unlisten> {
  let cancelled = false;
  const unlisteners: Unlisten[] = [];
  const pending = registrations.map(async (register) => {
    const unlisten = await register();
    if (cancelled) {
      unlisten();
      return;
    }
    unlisteners.push(unlisten);
  });

  try {
    await withTimeout(
      Promise.all(pending),
      timeoutMs,
      `The desktop event bridge did not become ready within ${timeoutMs / 1000} seconds.`
    );
  } catch (error) {
    cancelled = true;
    unlisteners.splice(0).forEach((unlisten) => unlisten());
    throw error;
  }

  return () => {
    cancelled = true;
    unlisteners.splice(0).forEach((unlisten) => unlisten());
  };
}

export function gameCreateInput(input: CreateGameInput): Extract<
  CoreCommand,
  { type: "gameCreate" }
>["input"] {
  return {
    name: input.name,
    defaultLaunchUrl: input.defaultLaunchUrl,
    localStorageSyncKeys: input.localStorageSyncKeys,
    ...(typeof input.iconImageDataUrl === "string"
      ? { iconImageDataUrl: input.iconImageDataUrl }
      : {}),
    ...(typeof input.coverImageDataUrl === "string"
      ? { coverImageDataUrl: input.coverImageDataUrl }
      : {}),
  };
}

export function gameUpdateInput(input: UpdateGameInput): Extract<
  CoreCommand,
  { type: "gameUpdate" }
>["input"] {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.defaultLaunchUrl === undefined
      ? {}
      : { defaultLaunchUrl: input.defaultLaunchUrl }),
    ...(input.localStorageSyncKeys === undefined
      ? {}
      : { localStorageSyncKeys: input.localStorageSyncKeys }),
    ...(typeof input.iconImageDataUrl === "string"
      ? { iconImageDataUrl: input.iconImageDataUrl }
      : {}),
    setIconImageDataUrl: input.iconImageDataUrl !== undefined,
    ...(typeof input.coverImageDataUrl === "string"
      ? { coverImageDataUrl: input.coverImageDataUrl }
      : {}),
    setCoverImageDataUrl: input.coverImageDataUrl !== undefined,
  };
}

export function roleCreateInput(input: CreateRoleInput): Extract<
  CoreCommand,
  { type: "roleCreate" }
>["input"] {
  return {
    gameId: input.gameId,
    name: input.name,
    ...(input.launchUrl === undefined ? {} : { launchUrl: input.launchUrl }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(typeof input.coverImageDataUrl === "string"
      ? { coverImageDataUrl: input.coverImageDataUrl }
      : {}),
    ...(typeof input.coverImageDominantColor === "string"
      ? { coverImageDominantColor: input.coverImageDominantColor }
      : {}),
    ...(typeof input.localStorageSourceRoleId === "string"
      ? { localStorageSourceRoleId: input.localStorageSourceRoleId }
      : {})
  };
}

export function roleUpdateInput(input: UpdateRoleInput): Extract<
  CoreCommand,
  { type: "roleUpdate" }
>["input"] {
  return {
    ...(input.gameId === undefined ? {} : { gameId: input.gameId }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.launchUrl === undefined ? {} : { launchUrl: input.launchUrl }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(typeof input.coverImageDataUrl === "string"
      ? { coverImageDataUrl: input.coverImageDataUrl }
      : {}),
    setCoverImageDataUrl: input.coverImageDataUrl !== undefined,
    ...(typeof input.coverImageDominantColor === "string"
      ? { coverImageDominantColor: input.coverImageDominantColor }
      : {}),
    setCoverImageDominantColor: input.coverImageDominantColor !== undefined,
    ...(typeof input.localStorageSourceRoleId === "string"
      ? { localStorageSourceRoleId: input.localStorageSourceRoleId }
      : {}),
    setLocalStorageSourceRoleId: input.localStorageSourceRoleId !== undefined
  };
}

function rendererLogRecord(event: RendererLogEvent): Extract<
  CoreCommand,
  { type: "logsCapture" }
>["entries"][number] {
  return {
    level: "error",
    source: "renderer",
    event: event.event,
    message: event.message,
    ...(event.stack
      ? {
          error: {
            message: event.message,
            name: event.event,
            stack: event.stack
          }
        }
      : {})
  };
}

async function invokeCore<C extends CoreCommand>(command: C): Promise<CoreCommandResult<C>> {
  return invoke<CoreCommandResult<C>>("rion_core_invoke", { command });
}

async function invokeShell<T>(operation: string, args: unknown[] = []): Promise<T> {
  return invoke<T>("rion_shell_invoke", { operation, args });
}

function isTauriRuntime(): boolean {
  return Reflect.has(window, "__TAURI_INTERNALS__");
}

export async function reportRendererStartupFailure(message: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeShell("rendererStartupFailed", [message]);
}

export async function installTauriBridgeIfNeeded(): Promise<void> {
  if (window.rionStudio || !isTauriRuntime()) return;

  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...payload: unknown[]): void => {
    listeners.get(event)?.forEach((listener) => listener(...payload as never[]));
  };
  const on = (event: string, callback: Listener): (() => void) => {
    const selected = listeners.get(event) ?? new Set<Listener>();
    selected.add(callback);
    listeners.set(event, selected);
    return () => {
      selected.delete(callback);
      if (selected.size === 0) listeners.delete(event);
    };
  };

  const maybeAutoRestoreSavedWindows = async (): Promise<void> => {
    const [legal, preferences] = await Promise.all([
      invokeCore({
        type: "legalAcceptanceStatus"
      }),
      invokeCore({ type: "runtimeWindowPreferencesGet" })
    ]);
    if (legal.isAccepted && preferences.restoreGameWindowsOnStartup) {
      await invokeShell("autoRestoreSavedGameWindows");
    }
  };

  const refreshCollections = async (collections: string[]): Promise<void> => {
    const jobs: Promise<void>[] = [];
    if (collections.includes("games")) {
      jobs.push(invokeCore({ type: "gamesList" }).then((games) => emit("games", games)));
    }
    if (collections.includes("launchWorkspaces")) {
      jobs.push(invokeCore({ type: "workspacesList" })
        .then((workspaces) => emit("workspaces", workspaces)));
    }
    if (collections.includes("gameWindows")) {
      jobs.push(invokeCore({ type: "gameWindowsList" })
        .then((gameWindows) => emit("gameWindows", gameWindows)));
    }
    if (collections.includes("macros")) {
      jobs.push(invokeCore({ type: "macrosList" }).then((macros) => emit("macros", macros)));
    }
    if (collections.includes("compatibilityReports")) {
      jobs.push(Promise.all([
        invokeCore({ type: "stateSnapshot" }),
        invokeCore({ type: "compatibilityStatuses" })
      ]).then(([snapshot, statuses]) => {
        emit("compatibility", snapshot.compatibilityReports, statuses);
      }));
    }
    await Promise.all(jobs);
  };

  const unlistenBridge = await registerBridgeListeners([
    () => listen<CoreEvent[]>("rion://core-events", ({ payload }) => {
      for (const event of payload) {
        switch (event.type) {
          case "stateChanged":
            void refreshCollections(event.changedCollections);
            break;
          case "browserStatuses":
            emit("roleStatuses", event.statuses);
            void invokeShell<Awaited<ReturnType<RionStudioApi["getEmbeddedRuntimeState"]>>>(
              "embeddedRuntimeState"
            ).then((runtimeState) => emit("runtimeState", runtimeState));
            break;
          case "macroStatuses":
            emit("macroStatuses", event.statuses);
            break;
          case "compatibilityStatuses":
            void refreshCollections(["compatibilityReports"]);
            break;
          case "logEntriesCaptured":
            event.entries.forEach((entry) => emit("logEntry", entry));
            break;
          case "chromeProfileImportProgress":
            emit("chromeProfileImportProgress", event.progress);
            break;
          case "legacySessionsRestored":
            emit("legacySessionsRestored", event.records);
            break;
          case "coreEffects":
            // The Rust Tauri executor consumes effect events before renderer delivery.
            break;
        }
      }
    }),
    () => listen<Awaited<ReturnType<RionStudioApi["getEmbeddedRuntimeState"]>>>(
      "rion://runtime-state",
      ({ payload }) => emit("runtimeState", payload)
    ),
    () => listen<Parameters<Parameters<RionStudioApi["onMacroPageRequested"]>[0]>[0]>(
      "rion://macro-page-request",
      ({ payload }) => emit("macroPageRequest", payload)
    ),
    () => listen<Awaited<ReturnType<RionStudioApi["getCurrentWindowState"]>>>(
      "rion://window-state",
      ({ payload }) => emit("windowState", payload)
    ),
    () => listen<Awaited<ReturnType<RionStudioApi["listDisplays"]>>>(
      "rion://displays",
      ({ payload }) => emit("displays", payload)
    ),
    () => listen<Awaited<ReturnType<RionStudioApi["getUpdateStatus"]>>>(
      "rion://update-status",
      ({ payload }) => emit("updateStatus", payload)
    ),
    () => listen<{ code: string; message: string }>(
      "rion://shell-error",
      ({ payload }) => console.error(`[${payload.code}] ${payload.message}`)
    ),
    () => listen("rion://quick-menu-restore", () => {
      void invokeShell("restoreSavedGameWindows", [{ scope: "all" }])
        .then(() => invokeShell("refreshQuickMenu"))
        .catch((error) => console.error("Quick Menu restore failed.", error));
    })
  ]);
  window.addEventListener("pagehide", () => {
    unlistenBridge();
  }, { once: true });

  const api: RionStudioApi = {
    notifyRendererReady: async () => {
      await invokeShell("rendererReady");
      void maybeAutoRestoreSavedWindows()
        .catch((error) => console.error("Saved Game Window restore failed.", error));
    },
    getAppSnapshot: () => invokeShell("appSnapshot"),
    getCurrentWindowState: () => invokeShell("currentWindowState"),
    getLegalAcceptanceStatus: () => invokeCore({ type: "legalAcceptanceStatus" }),
    acceptLegalDocuments: async (input) => {
      const status = await invokeCore({
        type: "legalAcceptanceAccept",
        input
      });
      await invokeShell("refreshQuickMenu");
      await maybeAutoRestoreSavedWindows();
      return status;
    },
    quitApplication: () => invokeShell("quitApplication"),
    requestCurrentWindowClose: () => void invokeShell("requestCurrentWindowClose"),
    restartApplication: () => invokeShell("restartApplication"),
    getEmbeddedRuntimeState: () => invokeShell("embeddedRuntimeState"),
    listGameWindows: () => invokeCore({ type: "gameWindowsList" }),
    createGameWindow: async (input) => {
      const gameWindow = await invokeCore({ type: "gameWindowCreate", input });
      await invokeShell("showGameWindow", [gameWindow.id]);
      return gameWindow;
    },
    updateGameWindow: (id, input) => invokeShell("updateGameWindow", [id, input]),
    reorderGameWindows: (input) =>
      invokeCore({ type: "gameWindowReorder", orderedIds: input.orderedIds }),
    showGameWindow: (windowId) => invokeShell("showGameWindow", [windowId]),
    closeGameWindow: (windowId) => invokeShell("closeGameWindow", [windowId]),
    stopGameWindow: (windowId) => invokeShell("stopGameWindow", [windowId]),
    deleteGameWindow: (windowId) => invokeShell("deleteGameWindow", [windowId]),
    showGameWindowTab: (tabId) => invokeShell("showGameWindowTab", [tabId]),
    moveGameWindowTab: (tabId, windowId) =>
      invokeShell("moveGameWindowTab", [tabId, windowId]),
    moveGameWindowTabToNewWindow: (tabId) =>
      invokeShell("moveGameWindowTabToNewWindow", [tabId]),
    setGameWindowTabMuted: (tabId, muted) =>
      invokeShell("setGameWindowTabMuted", [tabId, muted]),
    setGameWindowTabHidden: (tabId, hidden) =>
      invokeShell("setGameWindowTabHidden", [tabId, hidden]),
    stopGameWindowTab: (tabId) => invokeShell("stopGameWindowTab", [tabId]),
    restoreSavedGameWindows: async (input) => {
      const result = await invokeShell<void>("restoreSavedGameWindows", [input]);
      await invokeShell("refreshQuickMenu");
      return result;
    },
    discardSavedGameWindows: async (input) => {
      const result = await invokeShell<void>("discardSavedGameWindows", [input]);
      await invokeShell("refreshQuickMenu");
      return result;
    },
    getRuntimeWindowPreferences: () => invokeCore({ type: "runtimeWindowPreferencesGet" }),
    updateRuntimeWindowPreferences: (preferences) =>
      invokeCore({ type: "runtimeWindowPreferencesReplace", preferences }),
    listGames: () => invokeCore({ type: "gamesList" }),
    createGame: (input) => invokeCore({ type: "gameCreate", input: gameCreateInput(input) }),
    updateGame: (id, input) =>
      invokeCore({ type: "gameUpdate", id, input: gameUpdateInput(input) }),
    resetBuiltinGame: (id) => invokeCore({ type: "gameResetBuiltin", id }),
    deleteGame: (id) => invokeCore({ type: "gameDelete", id }).then(() => undefined),
    deleteGames: (input) => invokeCore({ type: "gamesDelete", ids: input.ids }),
    listGameCompatibilityReports: () =>
      invokeCore({ type: "stateSnapshot" }).then((snapshot) => snapshot.compatibilityReports),
    runGameCompatibilityCheck: (id) => invokeShell("runGameCompatibilityCheck", [id]),
    cancelGameCompatibilityCheck: (id) =>
      invokeCore({ type: "compatibilityCancel", gameId: id }).then(() => undefined),
    listRoles: () => invokeCore({ type: "rolesList" }),
    createRole: (input) => invokeCore({ type: "roleCreate", input: roleCreateInput(input) }),
    updateRole: (id, input) =>
      invokeCore({ type: "roleUpdate", id, input: roleUpdateInput(input) }),
    reorderRoles: (input) =>
      invokeCore({ type: "roleReorder", orderedIds: input.orderedIds }),
    deleteRole: (id) => invokeCore({ type: "roleDelete", id }).then(() => undefined),
    deleteRoles: (input) => invokeCore({ type: "rolesDelete", ids: input.ids }),
    clearRoleBrowserData: (id) => invokeCore({ type: "roleBrowserDataClear", roleId: id }),
    getRolePaths: (id) => invokeCore({ type: "rolePathsResolve", id }),
    launchRole: (id, input) => invokeShell("launchRole", [id, input]),
    stopRole: (id) => invokeCore({ type: "browserRoleStop", roleId: id }).then(() => undefined),
    listRoleStatuses: () => invokeCore({ type: "browserStatuses" }),
    listLaunchWorkspaces: () => invokeCore({ type: "workspacesList" }),
    createLaunchWorkspace: (input) =>
      invokeCore({ type: "workspaceCreate", input: toWorkspaceCreateInput(input) }),
    updateLaunchWorkspace: (id, input) => invokeCore({
      type: "workspaceUpdate",
      id,
      input: toWorkspaceUpdateInput(input)
    }),
    reorderLaunchWorkspaces: (input) =>
      invokeCore({ type: "workspaceReorder", orderedIds: input.orderedIds }),
    deleteLaunchWorkspace: (id) =>
      invokeCore({ type: "workspaceDelete", id }).then(() => undefined),
    deleteLaunchWorkspaces: (input) =>
      invokeCore({ type: "workspacesDelete", ids: input.ids }),
    listDisplays: () => invokeShell("displays"),
    launchWorkspace: (id, input) => invokeShell("launchWorkspace", [id, input]),
    stopLaunchWorkspace: (id) =>
      invokeCore({ type: "browserWorkspaceStop", workspaceId: id }).then(() => undefined),
    listMacros: () => invokeCore({ type: "macrosList" }),
    createMacro: (input) =>
      invokeCore({ type: "macroCreate", input: toMacroCreateInput(input) }),
    updateMacro: (id, input) => invokeCore({
      type: "macroUpdate",
      id,
      input: toMacroUpdateInput(input)
    }),
    deleteMacro: (id) => invokeCore({ type: "macroDelete", id }).then(() => undefined),
    deleteMacros: (input) => invokeCore({ type: "macrosDelete", ids: input.ids }),
    startMacro: (macroId) => invokeShell("startMacro", [macroId]),
    stopMacro: (macroId) => invokeCore({ type: "macroStop", macroId }).then(() => undefined),
    listMacroStatuses: () =>
      invokeCore({ type: "macroStatuses" }).then((statuses) => statuses as MacroRunStatus[]),
    getMacroSettings: () => invokeCore({ type: "macroSettingsGet" }),
    updateMacroSettings: (settings) =>
      invokeCore({ type: "macroSettingsReplace", settings }),
    exportPortableData: (input) => invokeShell("exportPortableData", [input]),
    previewPortableImport: () => invokeShell("previewPortableImport"),
    applyPortableImport: (input) => invokeShell("applyPortableImport", [input]),
    discardPortableImport: (importId) =>
      invokeCore({ type: "portableDiscard", importId }).then(() => undefined),
    previewChromeProfileImport: () => invokeShell("previewChromeProfileImport"),
    requestChromeQuitForImport: (importId) =>
      invokeCore({ type: "chromeProfileRequestQuit", importId }),
    applyChromeProfileImport: (input) => invokeCore({
      type: "chromeProfileApply",
      importId: input.importId,
      gameId: input.gameId,
      consentAccepted: input.consentAccepted,
      resolutions: input.resolutions
    }),
    discardChromeProfileImport: (importId) =>
      invokeCore({ type: "chromeProfileDiscard", importId }).then(() => undefined),
    getGameBrowserSettings: () => invokeCore({ type: "gameBrowserSettingsGet" }),
    updateGameBrowserSettings: (settings) =>
      invokeCore({ type: "gameBrowserSettingsReplace", settings }),
    getGraphicsDiagnostics: () => invokeShell("getGraphicsDiagnostics"),
    getLogStatus: () => invokeCore({ type: "logsStatus" }),
    queryLogs: (query) => invokeCore({ type: "logsQuery", query: query ?? {} }),
    setLogLevel: (level) =>
      invokeCore({ type: "logsSetLevel", level }).then(() => invokeCore({ type: "logsStatus" })),
    clearLogs: () =>
      invokeCore({ type: "logsClear" }).then(() => invokeCore({ type: "logsStatus" })),
    revealLogs: () => invokeShell("revealLogs"),
    exportDiagnostics: () => invokeShell("exportDiagnostics"),
    reportRendererLog: (event) =>
      void invokeCore({ type: "logsCapture", entries: [rendererLogRecord(event)] }),
    listSystemFonts: () => invokeCore({ type: "systemFontsList" }),
    consumePendingMacroPageRequest: () => invokeShell("consumePendingMacroPageRequest"),
    setOverlayLanguage: (language) =>
      invokeCore({ type: "overlayLanguageSet", language }).then(() => undefined),
    getAppVersion: () => invokeShell("appVersion"),
    getUpdateStatus: () => invokeShell("updateStatus"),
    checkForUpdates: () => invokeShell("checkForUpdates"),
    setAutoUpdateEnabled: (enabled) => invokeShell("setAutoUpdateEnabled", [enabled]),
    openUpdateDownload: () => invokeShell("openUpdateDownload"),
    installDownloadedUpdate: () => invokeShell("installDownloadedUpdate"),
    onRoleStatusChanged: (callback) => on("roleStatuses", callback as Listener),
    onCurrentWindowStateChanged: (callback) => on("windowState", callback as Listener),
    onEmbeddedRuntimeStateChanged: (callback) => on("runtimeState", callback as Listener),
    onGamesChanged: (callback) => on("games", callback as Listener),
    onGameWindowsChanged: (callback) => on("gameWindows", callback as Listener),
    onWorkspacesChanged: (callback) => on("workspaces", callback as Listener),
    onGameCompatibilityChanged: (callback) => on("compatibility", callback as Listener),
    onDisplaysChanged: (callback) => on("displays", callback as Listener),
    onMacroStatusChanged: (callback) => on("macroStatuses", callback as Listener),
    onMacrosChanged: (callback) => on("macros", callback as Listener),
    onMacroPageRequested: (callback) => on("macroPageRequest", callback as Listener),
    onUpdateStatusChanged: (callback) => on("updateStatus", callback as Listener),
    onLogEntryAdded: (callback) => on("logEntry", callback as Listener),
    onChromeProfileImportProgress: (callback) =>
      on("chromeProfileImportProgress", callback as Listener),
    onLegacySessionsRestored: (callback) =>
      on("legacySessionsRestored", callback as Listener)
  };

  Object.defineProperty(window, "rionStudio", {
    configurable: false,
    enumerable: true,
    value: api,
    writable: false
  });
}
