import { app, Menu, Tray } from "electron";

import type { AppLanguage } from "../../shared/types";
import { normalizeRionBridgeError } from "../ipc/errors";
import type { ElectronRuntimeLaunchPort } from
  "./chromiumRuntimeLaunchCoordinator";
import type { ChromiumRuntimeActionsServices } from
  "./chromiumRuntimeActionsFactory";
import type { ElectronCoreEventSource } from "./coreRendererEventBridge";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import { ElectronQuickMenuController } from "./electronQuickMenuController";
import {
  ElectronQuickMenuHost,
  type ElectronQuickMenuTrayPort
} from "./electronQuickMenuHost";
import type { ElectronQuickMenuPlatform } from "./electronQuickMenuModel";
import type { ElectronMainLifecycle } from "./lifecycle";
import { macosRuntimeTabMenuLanguage } from "./macosRuntimeTabMenuTemplate";

export interface ElectronQuickMenuCompositionInput {
  readonly core: ElectronCoreCommandPort & ElectronCoreEventSource;
  readonly icon: Electron.NativeImage;
  readonly launches: Pick<ElectronRuntimeLaunchPort, "launchRole" | "launchWorkspace">;
  readonly lifecycle: Pick<
    ElectronMainLifecycle,
    "presentMainWindow" | "requestQuit"
  >;
  readonly onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
  readonly platform: ElectronQuickMenuPlatform;
  readonly runtimeActions: Pick<ChromiumRuntimeActionsServices, "showGameWindow">;
}

export interface ElectronQuickMenuComposition {
  readonly dispose: () => void;
  readonly observeNativeProjectionChanged: () => void;
  readonly setLanguage: (language: AppLanguage) => void;
}

/** Installs the shared model behind thin Electron Dock and Tray hosts. */
export function installElectronQuickMenu(
  input: ElectronQuickMenuCompositionInput
): ElectronQuickMenuComposition {
  const dock = app.dock;
  const host = new ElectronQuickMenuHost({
    platform: input.platform,
    menu: { buildFromTemplate: (template) => Menu.buildFromTemplate(template) },
    icon: input.icon,
    ...(input.platform === "darwin" && dock
      ? { dock: { setMenu: (menu) => dock.setMenu(menu as Menu) } }
      : {
          createTray: (icon) =>
            new Tray(icon) as unknown as ElectronQuickMenuTrayPort
        }),
    onPrimaryActivation: () => {
      void input.lifecycle.presentMainWindow().catch((error: unknown) => {
        input.onError(normalizeRionBridgeError(
          error,
          "ELECTRON_QUICK_MENU_ACTIVATION_FAILED"
        ));
      });
    }
  });
  const controller = new ElectronQuickMenuController({
    actions: {
      launchRole: (roleId) => input.launches.launchRole(roleId),
      launchWorkspace: (workspaceId) =>
        input.launches.launchWorkspace(workspaceId),
      presentMainWindow: () => input.lifecycle.presentMainWindow(),
      requestQuit: () => input.lifecycle.requestQuit(),
      showGameWindow: (windowId) => input.runtimeActions.showGameWindow(windowId),
      stopAllRoles: () => stopAllRoles(input.core)
    },
    apply: (entries, onAction) => host.apply(entries, onAction),
    initialLanguage: macosRuntimeTabMenuLanguage(app.getLocale()),
    onError: input.onError,
    platform: input.platform,
    state: {
      read: async () => {
        const [snapshot, legal] = await Promise.all([
          input.core.invoke({ type: "appSnapshot" }),
          input.core.invoke({ type: "legalAcceptanceStatus" })
        ]);
        return { snapshot, legal };
      },
      subscribe: (listener) => input.core.subscribeCoreEvents(listener)
    }
  });
  controller.start();
  let disposed = false;
  return Object.freeze({
    dispose: () => {
      if (disposed) return;
      disposed = true;
      controller.dispose();
      host.dispose();
    },
    observeNativeProjectionChanged: () =>
      controller.observeNativeProjectionChanged(),
    setLanguage: (language: AppLanguage) => controller.setLanguage(language)
  });
}

async function stopAllRoles(core: ElectronCoreCommandPort): Promise<void> {
  const statuses = await core.invoke({ type: "browserStatuses" });
  let firstFailure: unknown;
  for (const status of statuses) {
    try {
      await core.invoke({ type: "browserRoleStop", roleId: status.roleId });
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}
