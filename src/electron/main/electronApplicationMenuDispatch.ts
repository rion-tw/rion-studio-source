import type { BaseWindow } from "electron";
import { normalizeRionBridgeError } from "../ipc/errors";
import type { ElectronFocusedApplicationShortcutController } from "./electronFocusedApplicationShortcutController";

/** Keep native menu failures on the existing shell error boundary. */
export function createElectronApplicationMenuDispatch(
  controller: ElectronFocusedApplicationShortcutController,
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void
) {
  return {
    executeShortcut: (command: Parameters<typeof controller.execute>[0], focusedWindow?: BaseWindow): void => {
      void controller.execute(command, focusedWindow).catch((error: unknown) =>
        onError(normalizeRionBridgeError(error, "ELECTRON_APPLICATION_SHORTCUT_FAILED")));
    },
    executeQuickAccess: (focusedWindow?: BaseWindow): void => {
      try { controller.executeQuickAccess(focusedWindow); }
      catch (error) { onError(normalizeRionBridgeError(error, "ELECTRON_QUICK_ACCESS_SHORTCUT_FAILED")); }
    }
  };
}
