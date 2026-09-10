import type {
  AppKitRuntimeHostIdentityRecord,
  CoreAppSnapshotRecord,
  DisplayTopologySnapshotRecord,
  GameWindowSaveRuntimeInputRecord
} from "../../shared/generated";
import type { AppLanguage } from "../../shared/types";
import { RionBridgeError } from "../ipc/errors";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeEffectExecutor";
import type { ChromiumRuntimeNativeTabAction } from
  "./chromiumRuntimeNativeWindowController";
import type { ChromiumRuntimeLaunchCoordinator } from
  "./chromiumRuntimeLaunchCoordinator";
import { executeControlledRuntimeTabReload } from
  "./controlledRuntimeTabReload";
import {
  MacosAppKitRuntimeLauncherMenuController,
  type MacosAppKitRuntimeLauncherMenuOpenRequest
} from "./macosAppKitRuntimeLauncherMenu";
import {
  MacosAppKitRuntimeTabMenuController,
  type MacosAppKitRuntimeTabMenuItem,
  type MacosAppKitRuntimeTabMenuOpenRequest
} from "./macosAppKitRuntimeTabMenu";

interface MacosAppKitRuntimeMenusInput {
  readonly core: ElectronCoreCommandPort;
  readonly applyWindowName: (
    identity: AppKitRuntimeHostIdentityRecord,
    name: string
  ) => Readonly<{ name: string }>;
  readonly language: () => AppLanguage;
  readonly launches: Pick<
    ChromiumRuntimeLaunchCoordinator,
    "launchRole" | "launchWorkspace"
  >;
  readonly lifecycleEpoch: () => number;
  readonly nativeMenu: Readonly<{
    popup: (input: Readonly<{
      items: readonly MacosAppKitRuntimeTabMenuItem[];
      parentNativeHostId: number;
    }>) => void;
  }>;
  readonly onError: (error: unknown) => void;
  readonly readCoreSnapshot: () => Promise<CoreAppSnapshotRecord>;
  readonly readDisplayTopology: () => DisplayTopologySnapshotRecord;
  readonly readNativeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
  readonly requestRuntimeTabControl: (
    tabId: string,
    action: ChromiumRuntimeNativeTabAction
  ) => Promise<void>;
}

export interface MacosAppKitRuntimeMenus {
  readonly openLauncher: (
    request: MacosAppKitRuntimeLauncherMenuOpenRequest
  ) => Promise<void>;
  readonly openTabMenu: (
    request: MacosAppKitRuntimeTabMenuOpenRequest
  ) => Promise<void>;
  readonly retryFailed: (tabId: string) => Promise<void>;
}

async function saveWindow(
  core: ElectronCoreCommandPort,
  input: GameWindowSaveRuntimeInputRecord,
  identity: AppKitRuntimeHostIdentityRecord,
  applyWindowName: MacosAppKitRuntimeMenusInput["applyWindowName"]
): Promise<void> {
  const saved = await core.invoke({ type: "gameWindowSaveRuntime", input });
  if (saved.id !== input.windowId) {
    throw new RionBridgeError({
      code: "ELECTRON_MACOS_APPKIT_LAUNCHER_SAVE_RECEIPT_INVALID",
      message: "Core returned a mismatched saved Game Window receipt."
    });
  }
  const native = applyWindowName(identity, saved.name);
  if (native.name !== saved.name) {
    throw new RionBridgeError({
      code: "ELECTRON_MACOS_APPKIT_LAUNCHER_NAME_RECEIPT_INVALID",
      message: "AppKit returned a mismatched saved Game Window name receipt."
    });
  }
}

/** Composes retained AppKit menus without widening the renderer bridge. */
export function createMacosAppKitRuntimeMenus(
  input: MacosAppKitRuntimeMenusInput
): MacosAppKitRuntimeMenus {
  const launcher = new MacosAppKitRuntimeLauncherMenuController({
    actions: {
      activateTab: (tabId) => input.requestRuntimeTabControl(
        tabId,
        { type: "activateTab" }
      ),
      launchRole: (roleId, windowId) => input.launches.launchRole(
        roleId,
        { kind: "game-window", windowId }
      ),
      launchWorkspace: (workspaceId, windowId) =>
        input.launches.launchWorkspace(
          workspaceId,
          { kind: "game-window", windowId }
        ),
      saveWindow: (request, identity) => saveWindow(
        input.core,
        request,
        identity,
        input.applyWindowName
      )
    },
    language: input.language,
    lifecycleEpoch: input.lifecycleEpoch,
    nativeMenu: input.nativeMenu,
    onError: input.onError,
    readCoreSnapshot: input.readCoreSnapshot,
    readDisplayTopology: input.readDisplayTopology,
    readNativeSnapshot: input.readNativeSnapshot
  });
  const tabMenu = new MacosAppKitRuntimeTabMenuController({
    actions: {
      execute: async ({ action, source }) => {
        switch (action.type) {
          case "hide":
            await input.requestRuntimeTabControl(
              action.tabId,
              { type: "hideTab" }
            );
            return;
          case "move":
            await input.requestRuntimeTabControl(
              action.tabId,
              { type: "moveTab", targetWindowId: action.windowId }
            );
            return;
          case "moveToNewWindow":
            await input.requestRuntimeTabControl(
              action.tabId,
              { type: "moveTabToNewWindow" }
            );
            return;
          case "reload":
            await executeControlledRuntimeTabReload(input.core, {
              lifecycleEpoch: source.lifecycleEpoch,
              tabId: action.tabId,
              topologyRevision: source.topologyRevision,
              windowGeneration: source.windowGeneration,
              windowId: source.windowId
            });
            return;
          case "setMuted":
            await input.requestRuntimeTabControl(
              action.tabId,
              { muted: action.muted, type: "setTabMuted" }
            );
            return;
          case "stop":
            await input.requestRuntimeTabControl(
              action.tabId,
              { type: "closeTab" }
            );
        }
      }
    },
    language: input.language,
    lifecycleEpoch: input.lifecycleEpoch,
    nativeMenu: input.nativeMenu,
    onError: input.onError,
    readCoreSnapshot: input.readCoreSnapshot,
    readNativeSnapshot: input.readNativeSnapshot
  });
  return Object.freeze({
    openLauncher: (request: MacosAppKitRuntimeLauncherMenuOpenRequest) =>
      launcher.open(request),
    openTabMenu: (request: MacosAppKitRuntimeTabMenuOpenRequest) =>
      tabMenu.open(request),
    retryFailed: (tabId: string) => input.requestRuntimeTabControl(
      tabId,
      { type: "activateTab" }
    )
  });
}
