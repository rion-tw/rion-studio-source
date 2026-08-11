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
  CoreEvent,
  ApplicationLifecycleStatusRecord,
  RuntimeTabMoveResultRecord,
  SurfaceRecoveryAttemptRecord,
  SystemRuntimeOperationSummaryRecord
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
import { handleSystemRuntimeReceipt } from "../app/systemRuntimeReceipt";

type Listener = (...payload: never[]) => void;
type Unlisten = () => void;
type ListenerRegistration = () => Promise<Unlisten>;

const TAURI_BRIDGE_TIMEOUT_MS = 10_000;
const SNAPSHOT_COLLECTIONS = [
  "games",
  "roles",
  "launchWorkspaces",
  "gameWindows",
  "macros"
] as const;

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
    // event-topology-exception: renderer-bounded-bridge-wait
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
    ...(typeof input.iconImageDataUrl === "string"
      ? { iconImageDataUrl: input.iconImageDataUrl }
      : {}),
    ...(typeof input.coverImageDataUrl === "string"
      ? { coverImageDataUrl: input.coverImageDataUrl }
      : {}),
  };
}

function gameUpdateInput(input: UpdateGameInput): Extract<
  CoreCommand,
  { type: "gameUpdate" }
>["input"] {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.defaultLaunchUrl === undefined
      ? {}
      : { defaultLaunchUrl: input.defaultLaunchUrl }),
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

function roleCreateInput(input: CreateRoleInput): Extract<
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
    setCoverImageDominantColor: input.coverImageDominantColor !== undefined
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

export interface NativeStartupStatus {
  windowsMicaEnabled: boolean;
}

export async function waitForNativeStartup(): Promise<NativeStartupStatus> {
  if (!isTauriRuntime()) return { windowsMicaEnabled: false };
  return invokeShell<NativeStartupStatus>("waitForNativeStartup");
}

export async function installTauriBridgeIfNeeded(): Promise<void> {
  if (window.rionStudio || !isTauriRuntime()) return;

  const listeners = new Map<string, Set<Listener>>();
  const replayableEvents = new Set([
    "appSnapshot",
    "runtimeState",
    "displayTopology",
    "windowState"
  ]);
  const latestReplayPayload = new Map<string, unknown[]>();
  const latestProjectionRevision = new Map<string, number>();
  const emit = (event: string, ...payload: unknown[]): void => {
    if (replayableEvents.has(event)) latestReplayPayload.set(event, payload);
    listeners.get(event)?.forEach((listener) => listener(...payload as never[]));
  };
  const emitRevisioned = (
    event: string,
    payload: { revision: number }
  ): void => {
    const latest = latestProjectionRevision.get(event) ?? 0;
    if (payload.revision <= latest) return;
    latestProjectionRevision.set(event, payload.revision);
    emit(event, payload);
  };
  const on = (event: string, callback: Listener): (() => void) => {
    const selected = listeners.get(event) ?? new Set<Listener>();
    selected.add(callback);
    listeners.set(event, selected);
    const replay = latestReplayPayload.get(event);
    if (replay) callback(...replay as never[]);
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

  let runtimeStateRefreshSequence = 0;
  let roleStatusesRefreshSequence = 0;
  let macroStatusesRefreshSequence = 0;
  let displaysRefreshSequence = 0;
  let collectionRequestSequence = 0;
  let appSnapshotRefreshRequested = 0;
  let appSnapshotRefreshRunning = false;
  const refreshAppSnapshot = (): void => {
    if (!listeners.has("appSnapshot")) return;
    appSnapshotRefreshRequested += 1;
    if (appSnapshotRefreshRunning) return;
    appSnapshotRefreshRunning = true;
    void (async () => {
      while (true) {
        const requested = appSnapshotRefreshRequested;
        try {
          const snapshot = await invokeShell<
            Awaited<ReturnType<RionStudioApi["getAppSnapshot"]>>
          >("appSnapshot");
          if (requested === appSnapshotRefreshRequested) {
            emitRevisioned("appSnapshot", snapshot);
          }
        } catch (error) {
          if (requested === appSnapshotRefreshRequested) {
            console.error("Renderer app snapshot refresh failed.", error);
          }
        }
        if (requested === appSnapshotRefreshRequested) {
          appSnapshotRefreshRunning = false;
          return;
        }
      }
    })();
  };
  const refreshRuntimeState = (): void => {
    const sequence = ++runtimeStateRefreshSequence;
    void invokeShell<Awaited<ReturnType<RionStudioApi["getEmbeddedRuntimeState"]>>>(
      "embeddedRuntimeState"
    )
      .then((runtimeState) => {
        if (sequence === runtimeStateRefreshSequence) {
          emitRevisioned("runtimeState", runtimeState);
        }
      })
      .catch((error) => {
        if (sequence === runtimeStateRefreshSequence) {
          console.error("Embedded runtime state refresh failed.", error);
        }
      });
  };
  type CollectionName = typeof SNAPSHOT_COLLECTIONS[number];
  interface CollectionFollower {
    recoveryAttemptedRevision: number;
    requestedRevision: number;
    running: boolean;
  }
  const collectionFollowers = new Map<CollectionName, CollectionFollower>();
  const collectionQueries: Record<CollectionName, {
    event: string;
    query: () => Promise<unknown>;
  }> = {
    games: { event: "games", query: () => invokeCore({ type: "gamesList" }) },
    roles: { event: "roles", query: () => invokeCore({ type: "rolesList" }) },
    launchWorkspaces: {
      event: "workspaces",
      query: () => invokeCore({ type: "workspacesList" })
    },
    gameWindows: {
      event: "gameWindows",
      query: () => invokeCore({ type: "gameWindowsList" })
    },
    macros: { event: "macros", query: () => invokeCore({ type: "macrosList" }) }
  };
  const isCollectionName = (collection: string): collection is CollectionName =>
    SNAPSHOT_COLLECTIONS.some((candidate) => candidate === collection);
  let snapshotRecovery: Promise<void> | undefined;
  const recoverSnapshot = (revision: number): Promise<void> => {
    if (snapshotRecovery) return snapshotRecovery;
    const runtimeSequence = ++runtimeStateRefreshSequence;
    const roleStatusesSequence = ++roleStatusesRefreshSequence;
    const macroStatusesSequence = ++macroStatusesRefreshSequence;
    const displaySequence = ++displaysRefreshSequence;
    snapshotRecovery = invokeShell<Awaited<ReturnType<RionStudioApi["getAppSnapshot"]>>>(
      "appSnapshot"
    ).then((snapshot) => {
      const current = (collection: CollectionName): boolean =>
        (collectionFollowers.get(collection)?.requestedRevision ?? 0) <= revision;
      if (current("games")) emit("games", snapshot.games);
      if (current("roles")) emit("roles", snapshot.roles);
      if (current("launchWorkspaces")) emit("workspaces", snapshot.launchWorkspaces);
      if (current("gameWindows")) emit("gameWindows", snapshot.gameWindows);
      if (current("macros")) emit("macros", snapshot.macros);
      if (roleStatusesSequence === roleStatusesRefreshSequence) {
        emit("roleStatuses", snapshot.roleStatuses);
      }
      if (macroStatusesSequence === macroStatusesRefreshSequence) {
        emit("macroStatuses", snapshot.macroStatuses);
      }
      if (displaySequence === displaysRefreshSequence) {
        emitRevisioned("displayTopology", snapshot.displayTopology);
      }
      if (runtimeSequence === runtimeStateRefreshSequence) {
        emitRevisioned("runtimeState", snapshot.embeddedRuntimeState);
      }
    }).catch((error) => {
      console.error("Renderer state snapshot recovery failed.", error);
    }).finally(() => {
      snapshotRecovery = undefined;
    });
    return snapshotRecovery;
  };
  const followCollection = async (collection: CollectionName): Promise<void> => {
    const follower = collectionFollowers.get(collection);
    if (!follower || follower.running) return;
    follower.running = true;
    while (true) {
      const requestedRevision = follower.requestedRevision;
      try {
        const value = await collectionQueries[collection].query();
        if (follower.requestedRevision === requestedRevision) {
          emit(collectionQueries[collection].event, value);
        }
      } catch (error) {
        if (follower.requestedRevision === requestedRevision
          && follower.recoveryAttemptedRevision !== requestedRevision) {
          follower.recoveryAttemptedRevision = requestedRevision;
          await recoverSnapshot(requestedRevision);
        } else if (follower.requestedRevision === requestedRevision) {
          console.error(`Renderer ${collection} refresh failed.`, error);
        }
      }
      if (follower.requestedRevision === requestedRevision) {
        follower.running = false;
        return;
      }
    }
  };
  const refreshCollections = (collections: string[], revision?: number): void => {
    const requestedRevision = revision ?? collectionRequestSequence + 1;
    collectionRequestSequence = Math.max(collectionRequestSequence, requestedRevision);
    for (const collection of new Set(collections)) {
      if (!isCollectionName(collection)) continue;
      const follower = collectionFollowers.get(collection) ?? {
        recoveryAttemptedRevision: 0,
        requestedRevision: 0,
        running: false
      };
      if (requestedRevision <= follower.requestedRevision) continue;
      follower.requestedRevision = requestedRevision;
      collectionFollowers.set(collection, follower);
      void followCollection(collection);
    }
  };

  const unlistenBridge = await registerBridgeListeners([
    () => listen<CoreEvent[]>("rion://core-events", ({ payload }) => {
      for (const event of payload) {
        switch (event.type) {
          case "stateChanged":
            void refreshCollections(event.changedCollections, event.revision);
            refreshAppSnapshot();
            break;
          case "browserStatuses":
            roleStatusesRefreshSequence += 1;
            emit("roleStatuses", event.statuses);
            refreshRuntimeState();
            refreshAppSnapshot();
            break;
          case "macroStatuses":
            macroStatusesRefreshSequence += 1;
            emit("macroStatuses", event.statuses);
            refreshAppSnapshot();
            break;
          case "logEntriesCaptured":
            event.entries.forEach((entry) => emit("logEntry", entry));
            break;
          case "chromeProfileImportProgress":
            emit("chromeProfileImportProgress", event.progress);
            break;
          case "coreEffects":
            // The Rust Tauri executor consumes effect events before renderer delivery.
            break;
        }
      }
    }),
    () => listen<Awaited<ReturnType<RionStudioApi["getEmbeddedRuntimeState"]>>>(
      "rion://runtime-state",
      ({ payload }) => {
        runtimeStateRefreshSequence += 1;
        emitRevisioned("runtimeState", payload);
        refreshAppSnapshot();
      }
    ),
    () => listen<SystemRuntimeOperationSummaryRecord>(
      "rion://window-lifecycle",
      ({ payload }) => emit("windowLifecycle", payload)
    ),
    () => listen<ApplicationLifecycleStatusRecord>(
      "rion://application-lifecycle",
      ({ payload }) => emitRevisioned("applicationLifecycle", payload)
    ),
    () => listen<SurfaceRecoveryAttemptRecord>(
      "rion://surface-recovery-attempt",
      ({ payload }) => emit("surfaceRecoveryAttempt", payload)
    ),
    () => listen<Parameters<Parameters<RionStudioApi["onMacroPageRequested"]>[0]>[0]>(
      "rion://macro-page-request",
      ({ payload }) => emit("macroPageRequest", payload)
    ),
    () => listen<Awaited<ReturnType<RionStudioApi["getCurrentWindowState"]>>>(
      "rion://window-state",
      ({ payload }) => emitRevisioned("windowState", payload)
    ),
    () => listen<Awaited<ReturnType<RionStudioApi["getDisplayTopology"]>>>(
      "rion://display-topology",
      ({ payload }) => {
        displaysRefreshSequence += 1;
        emitRevisioned("displayTopology", payload);
        refreshAppSnapshot();
      }
    ),
    () => listen<Awaited<ReturnType<RionStudioApi["getUpdateStatus"]>>>(
      "rion://update-status",
      ({ payload }) => emit("updateStatus", payload)
    ),
    () => listen<{ code: string; message: string }>(
      "rion://shell-error",
      ({ payload }) => {
        console.error(`[${payload.code}] ${payload.message}`);
        emit("shellError", payload);
      }
    ),
    () => listen("rion://application-quit-requested", () => {
      emit("applicationQuitRequested");
    }),
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
    getApplicationLifecycleStatus: () => invokeShell("applicationLifecycleStatus"),
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
    confirmApplicationQuit: () => invokeShell("confirmApplicationQuit"),
    requestCurrentWindowClose: async () => handleSystemRuntimeReceipt(
      await invokeShell("requestCurrentWindowClose")
    ),
    minimizeCurrentWindow: async () => handleSystemRuntimeReceipt(
      await invokeShell("minimizeCurrentWindow")
    ),
    startCurrentWindowDrag: async () => handleSystemRuntimeReceipt(
      await invokeShell("startCurrentWindowDrag")
    ),
    toggleCurrentWindowMaximize: async () => handleSystemRuntimeReceipt(
      await invokeShell("toggleCurrentWindowMaximize")
    ),
    executeApplicationShortcut: (command) =>
      invokeShell("executeApplicationShortcut", [command]),
    getEmbeddedRuntimeState: () => invokeShell("embeddedRuntimeState"),
    listGameWindows: () => invokeCore({ type: "gameWindowsList" }),
    createGameWindow: (input) => invokeShell("createGameWindow", [input]),
    updateGameWindow: (id, input) => invokeShell("updateGameWindow", [id, input]),
    reorderGameWindows: (input) =>
      invokeCore({ type: "gameWindowReorder", orderedIds: input.orderedIds }),
    showGameWindow: (windowId) => invokeShell("showGameWindow", [windowId]),
    hideGameWindow: async (windowId) => handleSystemRuntimeReceipt(
      await invokeShell("hideGameWindow", [windowId])
    ),
    stopGameWindow: async (windowId) => handleSystemRuntimeReceipt(
      await invokeShell("stopGameWindow", [windowId])
    ),
    deleteGameWindow: async (windowId) => handleSystemRuntimeReceipt(
      await invokeShell("deleteGameWindow", [windowId])
    ),
    showGameWindowTab: async (tabId) => handleSystemRuntimeReceipt(
      await invokeShell("showGameWindowTab", [tabId])
    ),
    moveGameWindowTab: async (tabId, windowId) => handleSystemRuntimeReceipt(
      await invokeShell("moveGameWindowTab", [tabId, windowId])
    ),
    moveGameWindowTabToNewWindow: async (tabId) => {
      const result = await invokeShell<RuntimeTabMoveResultRecord>(
        "moveGameWindowTabToNewWindow",
        [tabId]
      );
      handleSystemRuntimeReceipt(result.receipt);
      return result;
    },
    reorderGameWindowTab: async (tabId, beforeTabId) => handleSystemRuntimeReceipt(
      await invokeShell(
        "reorderGameWindowTab",
        beforeTabId ? [tabId, beforeTabId] : [tabId]
      )
    ),
    setGameWindowTabMuted: async (tabId, muted) => handleSystemRuntimeReceipt(
      await invokeShell("setGameWindowTabMuted", [tabId, muted])
    ),
    setGameWindowTabHidden: async (tabId, hidden) => handleSystemRuntimeReceipt(
      await invokeShell("setGameWindowTabHidden", [tabId, hidden])
    ),
    stopGameWindowTab: async (tabId) => handleSystemRuntimeReceipt(
      await invokeShell("stopGameWindowTab", [tabId])
    ),
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
    launchRole: (id, destination) =>
      invokeShell("launchRole", destination ? [id, destination] : [id]),
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
    getDisplayTopology: () => invokeShell("displayTopology"),
    launchWorkspace: (id, destination) =>
      invokeShell("launchWorkspace", destination ? [id, destination] : [id]),
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
    patchGameBrowserSettings: (patch) =>
      invokeCore({ type: "gameBrowserSettingsPatch", patch }),
    listBrowserFontCatalog: () => invokeCore({ type: "browserFontCatalogList" }),
    installBrowserFont: (catalogId) =>
      invokeCore({ type: "browserFontPackInstall", catalogId }),
    installGoogleFont: (family) =>
      invokeCore({ type: "browserFontFamilyInstall", family }),
    removeBrowserFont: (catalogId) =>
      invokeCore({ type: "browserFontPackRemove", catalogId }),
    getBrowserFontPreview: (settings) =>
      invokeCore({ type: "browserFontRuntimePayload", settings }),
    getLogStatus: () => invokeCore({ type: "logsStatus" }),
    queryLogs: (query) => invokeCore({ type: "logsQuery", query: query ?? {} }),
    setLogLevel: (level) =>
      invokeCore({ type: "logsSetLevel", level }).then(() => invokeCore({ type: "logsStatus" })),
    clearLogs: () =>
      invokeCore({ type: "logsClear" }).then(() => invokeCore({ type: "logsStatus" })),
    revealLogs: () => invokeShell("revealLogs"),
    collectBrowserPerformanceDiagnostics: () =>
      invokeShell("collectBrowserPerformanceDiagnostics"),
    exportDiagnostics: () => invokeShell("exportDiagnostics"),
    reportRendererLog: (event) => {
      // This method is called from the global unhandled-rejection listener. A failed
      // log write must terminate here or it recursively reports its own rejection.
      void invokeCore({ type: "logsCapture", entries: [rendererLogRecord(event)] })
        .catch(() => undefined);
    },
    listSystemFonts: () => invokeCore({ type: "systemFontsList" }),
    consumePendingMacroPageRequest: () => invokeShell("consumePendingMacroPageRequest"),
    setOverlayLanguage: (language) =>
      invokeCore({ type: "overlayLanguageSet", language }).then(() => undefined),
    setRuntimeTheme: (theme) =>
      invokeCore({ type: "runtimeThemeSet", theme }).then(() => undefined),
    getAppVersion: () => invokeShell("appVersion"),
    getUpdateStatus: () => invokeShell("updateStatus"),
    checkForUpdates: () => invokeShell("checkForUpdates"),
    setAutoUpdateEnabled: (enabled) => invokeShell("setAutoUpdateEnabled", [enabled]),
    openUpdateDownload: () => invokeShell("openUpdateDownload"),
    installDownloadedUpdate: () => invokeShell("installDownloadedUpdate"),
    onRoleStatusChanged: (callback) => on("roleStatuses", callback as Listener),
    onAppSnapshotChanged: (callback) => {
      const unsubscribe = on("appSnapshot", callback as Listener);
      refreshAppSnapshot();
      return unsubscribe;
    },
    onApplicationQuitRequested: (callback) =>
      on("applicationQuitRequested", callback as Listener),
    onCurrentWindowStateChanged: (callback) => on("windowState", callback as Listener),
    onApplicationLifecycleChanged: (callback) =>
      on("applicationLifecycle", callback as Listener),
    onEmbeddedRuntimeStateChanged: (callback) => on("runtimeState", callback as Listener),
    onWindowLifecycleChanged: (callback) => on("windowLifecycle", callback as Listener),
    onSurfaceRecoveryAttemptChanged: (callback) =>
      on("surfaceRecoveryAttempt", callback as Listener),
    onGamesChanged: (callback) => on("games", callback as Listener),
    onRolesChanged: (callback) => on("roles", callback as Listener),
    onGameWindowsChanged: (callback) => on("gameWindows", callback as Listener),
    onWorkspacesChanged: (callback) => on("workspaces", callback as Listener),
    onDisplayTopologyChanged: (callback) => on("displayTopology", callback as Listener),
    onMacroStatusChanged: (callback) => on("macroStatuses", callback as Listener),
    onMacrosChanged: (callback) => on("macros", callback as Listener),
    onMacroPageRequested: (callback) => on("macroPageRequest", callback as Listener),
    onUpdateStatusChanged: (callback) => on("updateStatus", callback as Listener),
    onShellError: (callback) => on("shellError", callback as Listener),
    onLogEntryAdded: (callback) => on("logEntry", callback as Listener),
    onChromeProfileImportProgress: (callback) =>
      on("chromeProfileImportProgress", callback as Listener)
  };

  Object.defineProperty(window, "rionStudio", {
    configurable: false,
    enumerable: true,
    value: api,
    writable: false
  });
}
