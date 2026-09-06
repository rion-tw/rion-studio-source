import {
  toGameCreateInput,
  toGameUpdateInput,
  toMacroCreateInput,
  toMacroUpdateInput,
  toRoleCreateInput,
  toRoleUpdateInput,
  toWorkspaceCreateInput,
  toWorkspaceUpdateInput
} from "../../shared/domainInputs";
import type {
  CoreCommand,
  CoreCommandResult
} from "../../shared/generated";
import type {
  RionApiArgs,
  RionApiDispatchMethod,
  RionApiResult
} from "../ipc/apiMethods";
import { RionBridgeError } from "../ipc/errors";
import type { RionApiDispatcher } from "./registerIpcBridge";
import type { RendererIdentity } from "./rendererIdentity";
import type { ElectronRuntimeLaunchPort } from
  "./chromiumRuntimeLaunchCoordinator";
import type { ElectronChromiumRuntimeActionPort } from
  "./chromiumRuntimeActionController";

export interface ElectronCoreCommandPort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
}

const CORE_API_UNHANDLED = Symbol("CORE_API_UNHANDLED");
const RUNTIME_ACTION_METHODS = new Set<RionApiDispatchMethod>([
  "updateGameWindow",
  "showGameWindow",
  "hideGameWindow",
  "stopGameWindow",
  "deleteGameWindow",
  "showGameWindowTab",
  "moveGameWindowTab",
  "moveGameWindowTabToNewWindow",
  "reorderGameWindowTab",
  "setGameWindowTabMuted",
  "setGameWindowTabHidden",
  "stopGameWindowTab",
  "restoreSavedGameWindows",
  "discardSavedGameWindows",
  "updateRuntimeWindowPreferences",
  "consumePendingQuickAccessRequest",
  "presentQuickAccessRequest",
  "resolveQuickAccessRequest"
]);

function typedArgs<Method extends RionApiDispatchMethod>(
  args: unknown
): RionApiArgs<Method> {
  return args as RionApiArgs<Method>;
}

export function createElectronCoreApiDispatcher(
  core: ElectronCoreCommandPort,
  fallback: RionApiDispatcher,
  launches: ElectronRuntimeLaunchPort,
  runtimeActions?: ElectronChromiumRuntimeActionPort,
  systemFonts?: (identity: RendererIdentity) => Promise<string[]>
): RionApiDispatcher {
  return {
    async invoke<Method extends RionApiDispatchMethod>(
      identity: RendererIdentity,
      method: Method,
      args: RionApiArgs<Method>
    ): Promise<RionApiResult<Method>> {
      const value = await invokeCoreBackedMethod(
        core,
        launches,
        runtimeActions,
        identity,
        method,
        args,
        systemFonts
      );
      if (value === CORE_API_UNHANDLED) {
        return fallback.invoke(identity, method, args);
      }
      return value as RionApiResult<Method>;
    }
  };
}

async function invokeCoreBackedMethod<Method extends RionApiDispatchMethod>(
  core: ElectronCoreCommandPort,
  launches: ElectronRuntimeLaunchPort,
  runtimeActions: ElectronChromiumRuntimeActionPort | undefined,
  identity: RendererIdentity,
  method: Method,
  args: RionApiArgs<Method>,
  systemFonts: ((identity: RendererIdentity) => Promise<string[]>) | undefined
): Promise<unknown | typeof CORE_API_UNHANDLED> {
  if (!runtimeActions && RUNTIME_ACTION_METHODS.has(method)) {
    throw new RionBridgeError({
      code: "ELECTRON_CHROMIUM_RUNTIME_ACTIONS_UNAVAILABLE",
      message: "The privileged Core-owned runtime action lane is not initialized."
    });
  }
  switch (method) {
    case "getLegalAcceptanceStatus":
      return core.invoke({ type: "legalAcceptanceStatus" });
    case "acceptLegalDocuments": {
      const [input] = typedArgs<"acceptLegalDocuments">(args);
      return core.invoke({ type: "legalAcceptanceAccept", input });
    }
    case "listGameWindows":
      return core.invoke({ type: "gameWindowsList" });
    case "createGameWindow": {
      const [input] = typedArgs<"createGameWindow">(args);
      return core.invoke({ type: "gameWindowCreate", input });
    }
    case "updateGameWindow": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [windowId, input] = typedArgs<"updateGameWindow">(args);
      return runtimeActions.updateGameWindow(identity, windowId, input);
    }
    case "reorderGameWindows": {
      const [input] = typedArgs<"reorderGameWindows">(args);
      return core.invoke({ type: "gameWindowReorder", orderedIds: input.orderedIds });
    }
    case "showGameWindow": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [windowId] = typedArgs<"showGameWindow">(args);
      return runtimeActions.showGameWindow(identity, windowId);
    }
    case "hideGameWindow": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [windowId] = typedArgs<"hideGameWindow">(args);
      return runtimeActions.hideGameWindow(identity, windowId);
    }
    case "stopGameWindow": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [windowId] = typedArgs<"stopGameWindow">(args);
      return runtimeActions.stopGameWindow(identity, windowId);
    }
    case "deleteGameWindow": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [windowId] = typedArgs<"deleteGameWindow">(args);
      return runtimeActions.deleteGameWindow(identity, windowId);
    }
    case "showGameWindowTab": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [tabId] = typedArgs<"showGameWindowTab">(args);
      return runtimeActions.showGameWindowTab(identity, tabId);
    }
    case "moveGameWindowTab": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [tabId, windowId] = typedArgs<"moveGameWindowTab">(args);
      return runtimeActions.moveGameWindowTab(identity, tabId, windowId);
    }
    case "moveGameWindowTabToNewWindow": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [tabId] = typedArgs<"moveGameWindowTabToNewWindow">(args);
      return runtimeActions.moveGameWindowTabToNewWindow(identity, tabId);
    }
    case "reorderGameWindowTab": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [tabId, beforeTabId] = typedArgs<"reorderGameWindowTab">(args);
      return runtimeActions.reorderGameWindowTab(identity, tabId, beforeTabId);
    }
    case "setGameWindowTabMuted": {
      const [tabId, muted] = typedArgs<"setGameWindowTabMuted">(args);
      return runtimeActions
        ? runtimeActions.setGameWindowTabMuted(identity, tabId, muted)
        : core.invoke({ type: "browserTabAudioMute", tabId, muted });
    }
    case "setGameWindowTabHidden": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [tabId, hidden] = typedArgs<"setGameWindowTabHidden">(args);
      return runtimeActions.setGameWindowTabHidden(identity, tabId, hidden);
    }
    case "stopGameWindowTab": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [tabId] = typedArgs<"stopGameWindowTab">(args);
      return runtimeActions.stopGameWindowTab(identity, tabId);
    }
    case "restoreSavedGameWindows": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [input] = typedArgs<"restoreSavedGameWindows">(args);
      return runtimeActions.restoreSavedGameWindows(identity, input);
    }
    case "discardSavedGameWindows": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [input] = typedArgs<"discardSavedGameWindows">(args);
      return runtimeActions.discardSavedGameWindows(identity, input);
    }
    case "getRuntimeWindowPreferences":
      return core.invoke({ type: "runtimeWindowPreferencesGet" });
    case "updateRuntimeWindowPreferences": {
      const [preferences] = typedArgs<"updateRuntimeWindowPreferences">(args);
      return runtimeActions
        ? runtimeActions.updateRuntimeWindowPreferences(identity, preferences)
        : core.invoke({ type: "runtimeWindowPreferencesReplace", preferences });
    }
    case "setQuickAccessPinned": {
      const [item, pinned] = typedArgs<"setQuickAccessPinned">(args);
      return core.invoke({ type: "quickAccessPinSet", item, pinned });
    }
    case "recordQuickAccessUse": {
      const [item] = typedArgs<"recordQuickAccessUse">(args);
      return core.invoke({ type: "quickAccessRecentRecord", item });
    }
    case "clearQuickAccessRecent":
      return core.invoke({ type: "quickAccessRecentClear" });
    case "consumePendingQuickAccessRequest":
      return runtimeActions
        ? runtimeActions.consumePendingQuickAccessRequest(identity)
        : CORE_API_UNHANDLED;
    case "presentQuickAccessRequest": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [requestId] = typedArgs<"presentQuickAccessRequest">(args);
      return runtimeActions.presentQuickAccessRequest(identity, requestId);
    }
    case "resolveQuickAccessRequest": {
      if (!runtimeActions) return CORE_API_UNHANDLED;
      const [requestId, resolution] = typedArgs<"resolveQuickAccessRequest">(args);
      return runtimeActions.resolveQuickAccessRequest(
        identity,
        requestId,
        resolution
      );
    }
    case "listGames":
      return core.invoke({ type: "gamesList" });
    case "createGame": {
      const [input] = typedArgs<"createGame">(args);
      return core.invoke({ type: "gameCreate", input: toGameCreateInput(input) });
    }
    case "updateGame": {
      const [id, input] = typedArgs<"updateGame">(args);
      return core.invoke({ type: "gameUpdate", id, input: toGameUpdateInput(input) });
    }
    case "resetBuiltinGame": {
      const [id] = typedArgs<"resetBuiltinGame">(args);
      return core.invoke({ type: "gameResetBuiltin", id });
    }
    case "deleteGame": {
      const [id] = typedArgs<"deleteGame">(args);
      await core.invoke({ type: "gameDelete", id });
      return undefined;
    }
    case "deleteGames": {
      const [input] = typedArgs<"deleteGames">(args);
      return core.invoke({ type: "gamesDelete", ids: input.ids });
    }
    case "listRoles":
      return core.invoke({ type: "rolesList" });
    case "createRole": {
      const [input] = typedArgs<"createRole">(args);
      return core.invoke({ type: "roleCreate", input: toRoleCreateInput(input) });
    }
    case "updateRole": {
      const [id, input] = typedArgs<"updateRole">(args);
      return core.invoke({ type: "roleUpdate", id, input: toRoleUpdateInput(input) });
    }
    case "reorderRoles": {
      const [input] = typedArgs<"reorderRoles">(args);
      return core.invoke({ type: "roleReorder", orderedIds: input.orderedIds });
    }
    case "deleteRole": {
      const [id] = typedArgs<"deleteRole">(args);
      await core.invoke({ type: "roleDelete", id });
      return undefined;
    }
    case "deleteRoles": {
      const [input] = typedArgs<"deleteRoles">(args);
      return core.invoke({ type: "rolesDelete", ids: input.ids });
    }
    case "clearRoleBrowserData": {
      const [roleId] = typedArgs<"clearRoleBrowserData">(args);
      return core.invoke({ type: "roleBrowserDataClear", roleId });
    }
    case "clearGlobalWebProfile":
      await core.invoke({ type: "globalWebProfileClear" });
      return undefined;
    case "getRolePaths": {
      const [id] = typedArgs<"getRolePaths">(args);
      return core.invoke({ type: "rolePathsResolve", id });
    }
    case "launchRole": {
      const [roleId, destination] = typedArgs<"launchRole">(args);
      return launches.launchRole(roleId, destination);
    }
    case "stopRole": {
      const [roleId] = typedArgs<"stopRole">(args);
      await core.invoke({ type: "browserRoleStop", roleId });
      return undefined;
    }
    case "listRoleStatuses":
      return core.invoke({ type: "browserStatuses" });
    case "listLaunchWorkspaces":
      return core.invoke({ type: "workspacesList" });
    case "createLaunchWorkspace": {
      const [input] = typedArgs<"createLaunchWorkspace">(args);
      return core.invoke({ type: "workspaceCreate", input: toWorkspaceCreateInput(input) });
    }
    case "updateLaunchWorkspace": {
      const [id, input] = typedArgs<"updateLaunchWorkspace">(args);
      return core.invoke({ type: "workspaceUpdate", id, input: toWorkspaceUpdateInput(input) });
    }
    case "reorderLaunchWorkspaces": {
      const [input] = typedArgs<"reorderLaunchWorkspaces">(args);
      return core.invoke({ type: "workspaceReorder", orderedIds: input.orderedIds });
    }
    case "deleteLaunchWorkspace": {
      const [id] = typedArgs<"deleteLaunchWorkspace">(args);
      await core.invoke({ type: "workspaceDelete", id });
      return undefined;
    }
    case "deleteLaunchWorkspaces": {
      const [input] = typedArgs<"deleteLaunchWorkspaces">(args);
      return core.invoke({ type: "workspacesDelete", ids: input.ids });
    }
    case "launchWorkspace": {
      const [workspaceId, destination] = typedArgs<"launchWorkspace">(args);
      return launches.launchWorkspace(workspaceId, destination);
    }
    case "stopLaunchWorkspace": {
      const [workspaceId] = typedArgs<"stopLaunchWorkspace">(args);
      await core.invoke({ type: "browserWorkspaceStop", workspaceId });
      return undefined;
    }
    case "listMacros":
      return core.invoke({ type: "macrosList" });
    case "createMacro": {
      const [input] = typedArgs<"createMacro">(args);
      return core.invoke({ type: "macroCreate", input: toMacroCreateInput(input) });
    }
    case "updateMacro": {
      const [id, input] = typedArgs<"updateMacro">(args);
      return core.invoke({ type: "macroUpdate", id, input: toMacroUpdateInput(input) });
    }
    case "deleteMacro": {
      const [id] = typedArgs<"deleteMacro">(args);
      await core.invoke({ type: "macroDelete", id });
      return undefined;
    }
    case "deleteMacros": {
      const [input] = typedArgs<"deleteMacros">(args);
      return core.invoke({ type: "macrosDelete", ids: input.ids });
    }
    case "startMacro": {
      const [macroId] = typedArgs<"startMacro">(args);
      return core.invoke({
        type: "macroStart",
        request: { macroId, sourceRoleId: null }
      });
    }
    case "stopMacro": {
      const [macroId] = typedArgs<"stopMacro">(args);
      await core.invoke({ type: "macroStop", macroId });
      return undefined;
    }
    case "listMacroStatuses":
      return core.invoke({ type: "macroStatuses" });
    case "getMacroSettings":
      return core.invoke({ type: "macroSettingsGet" });
    case "updateMacroSettings": {
      const [settings] = typedArgs<"updateMacroSettings">(args);
      return core.invoke({ type: "macroSettingsReplace", settings });
    }
    case "discardPortableImport": {
      const [importId] = typedArgs<"discardPortableImport">(args);
      await core.invoke({ type: "portableDiscard", importId });
      return undefined;
    }
    case "applyPortableImport": {
      const [input] = typedArgs<"applyPortableImport">(args);
      return core.invoke({
        type: "portableApply",
        importId: input.importId,
        selection: input.selection,
        resolutions: input.resolutions ?? []
      });
    }
    case "requestChromeQuitForImport": {
      const [importId] = typedArgs<"requestChromeQuitForImport">(args);
      return core.invoke({ type: "chromeProfileRequestQuit", importId });
    }
    case "applyChromeProfileImport": {
      const [input] = typedArgs<"applyChromeProfileImport">(args);
      return core.invoke({
        type: "chromeProfileApply",
        importId: input.importId,
        gameId: input.gameId,
        consentAccepted: input.consentAccepted,
        resolutions: input.resolutions
      });
    }
    case "discardChromeProfileImport": {
      const [importId] = typedArgs<"discardChromeProfileImport">(args);
      await core.invoke({ type: "chromeProfileDiscard", importId });
      return undefined;
    }
    case "getGameBrowserSettings":
      return core.invoke({ type: "gameBrowserSettingsGet" });
    case "updateGameBrowserSettings": {
      const [settings] = typedArgs<"updateGameBrowserSettings">(args);
      return core.invoke({ type: "gameBrowserSettingsReplace", settings });
    }
    case "patchGameBrowserSettings": {
      const [patch] = typedArgs<"patchGameBrowserSettings">(args);
      return core.invoke({ type: "gameBrowserSettingsPatch", patch });
    }
    case "listBrowserFontCatalog":
      return core.invoke({ type: "browserFontCatalogList" });
    case "installBrowserFont": {
      const [catalogId] = typedArgs<"installBrowserFont">(args);
      return core.invoke({ type: "browserFontPackInstall", catalogId });
    }
    case "installGoogleFont": {
      const [family] = typedArgs<"installGoogleFont">(args);
      return core.invoke({ type: "browserFontFamilyInstall", family });
    }
    case "removeBrowserFont": {
      const [catalogId] = typedArgs<"removeBrowserFont">(args);
      return core.invoke({ type: "browserFontPackRemove", catalogId });
    }
    case "getBrowserFontPreview": {
      const [settings] = typedArgs<"getBrowserFontPreview">(args);
      return core.invoke({ type: "browserFontRuntimePayload", settings });
    }
    case "getLogStatus":
      return core.invoke({ type: "logsStatus" });
    case "queryLogs": {
      const [query] = typedArgs<"queryLogs">(args);
      return core.invoke({ type: "logsQuery", query: query ?? {} });
    }
    case "setLogLevel": {
      const [level] = typedArgs<"setLogLevel">(args);
      await core.invoke({ type: "logsSetLevel", level });
      return core.invoke({ type: "logsStatus" });
    }
    case "clearLogs":
      await core.invoke({ type: "logsClear" });
      return core.invoke({ type: "logsStatus" });
    case "listSystemFonts":
      return core.invoke({ type: "systemFontsList", families: await systemFonts?.(identity) ?? [] });
    case "setOverlayLanguage": {
      const [language] = typedArgs<"setOverlayLanguage">(args);
      await core.invoke({ type: "overlayLanguageSet", language });
      return undefined;
    }
    case "setRuntimeTheme": {
      const [theme] = typedArgs<"setRuntimeTheme">(args);
      await core.invoke({ type: "runtimeThemeSet", theme });
      return undefined;
    }
    default:
      return CORE_API_UNHANDLED;
  }
}
