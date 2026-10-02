import type { MenuItemConstructorOptions } from "electron";
import { RuntimeLauncherMenuController } from "./runtimeLauncherMenu";
import type { MacosAppKitRuntimeTabMenuItem } from "./macosAppKitRuntimeTabMenu";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type { ChromiumRuntimeLaunchCoordinator } from "./chromiumRuntimeLaunchCoordinator";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeEffectExecutor";
import type { DisplayTopologySnapshotRecord } from "../../shared/generated";
import { readWorkspaceWebLanguage } from "./workspaceStartPage";
import { RionBridgeError } from "../ipc/errors";
import { normalizeRionBridgeError } from "../ipc/errors";
import { createWindowsRuntimeWindows } from "./windowsWorkspaceResizeIndicators";

export function createWindowsRuntimeUiFactory(
  Window: Parameters<typeof createWindowsRuntimeWindows>[0],
  menu: NonNullable<Parameters<typeof createWindowsRuntimeWindows>[3]>["menu"],
  icon: string | undefined,
  input: Readonly<{
    core: () => ElectronCoreCommandPort;
    services: () => { requestRuntimeTabControl: (tabId: string, action: { type: "activateTab" }) => Promise<void> };
    runtime: () => { applyRuntimeWindowName: (id: string, name: string) => string | null; snapshot: () => ChromiumRuntimeExecutorSnapshot };
    launches: () => Pick<ChromiumRuntimeLaunchCoordinator, "launchRole" | "launchWorkspace">;
    displays: () => DisplayTopologySnapshotRecord;
    epoch: () => number;
    onError: (error: import("../../shared/generated").CoreErrorPayload) => void;
  }>
) {
  const onError = (error: unknown) => input.onError(normalizeRionBridgeError(error, "ELECTRON_WINDOWS_RUNTIME_UI_FAILED"));
  return createWindowsRuntimeWindows(Window, icon, onError, { menu,
    openLauncher: (windowId, nativeId, popup) => openWindowsRuntimeLauncher({
      windowId, nativeId, popup, core: input.core(), launches: input.launches(),
      activateTab: tabId => input.services().requestRuntimeTabControl(tabId, { type: "activateTab" }),
      applyWindowName: (id, name) => input.runtime().applyRuntimeWindowName(id, name),
      lifecycleEpoch: input.epoch, readNativeSnapshot: () => input.runtime().snapshot(),
      readDisplayTopology: input.displays, onError
    })
  });
}

function item(value: MacosAppKitRuntimeTabMenuItem): MenuItemConstructorOptions {
  const { submenu, ...rest } = value;
  return { ...rest, ...(submenu ? { submenu: submenu.map(item) } : {}) };
}

export async function openWindowsRuntimeLauncher(input: Readonly<{
  windowId: string;
  nativeId: number;
  popup: (items: MenuItemConstructorOptions[]) => void;
  core: ElectronCoreCommandPort;
  launches: Pick<ChromiumRuntimeLaunchCoordinator, "launchRole" | "launchWorkspace">;
  activateTab: (tabId: string) => Promise<unknown>;
  applyWindowName: (windowId: string, name: string) => string | null;
  lifecycleEpoch: () => number;
  readNativeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
  readDisplayTopology: () => DisplayTopologySnapshotRecord;
  onError: (error: unknown) => void;
}>): Promise<void> {
  const controller = new RuntimeLauncherMenuController({
    platform: "win32", language: readWorkspaceWebLanguage,
    lifecycleEpoch: input.lifecycleEpoch,
    readCoreSnapshot: () => input.core.invoke({ type: "appSnapshot" }),
    readNativeSnapshot: input.readNativeSnapshot,
    readDisplayTopology: input.readDisplayTopology,
    nativeMenu: { popup: ({ items, parentNativeHostId }) => {
      if (parentNativeHostId === input.nativeId) input.popup(items.map(item));
    } },
    onError: input.onError,
    actions: {
      activateTab: input.activateTab,
      launchRole: (roleId, windowId) => input.launches.launchRole(roleId, { kind: "game-window", windowId }),
      launchWorkspace: (workspaceId, windowId) => input.launches.launchWorkspace(workspaceId, { kind: "game-window", windowId }),
      saveWindow: async request => {
        const saved = await input.core.invoke({ type: "gameWindowSaveRuntime", input: request });
        if (saved.id !== request.windowId || input.applyWindowName(saved.id, saved.name) !== saved.name) {
          throw new RionBridgeError({ code: "ELECTRON_WINDOWS_LAUNCHER_SAVE_RECEIPT_INVALID",
            message: "The saved Game Window name did not reach its exact Windows host." });
        }
      }
    }
  });
  await controller.openWindows(input.windowId, input.nativeId);
}
