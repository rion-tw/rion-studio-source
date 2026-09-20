import { BrowserWindow } from "electron";
import { RionBridgeError } from "../ipc/errors";
import type { WindowsRuntimeShortcutOwnerDiagnostic, WindowsRuntimeShortcutOwnerDiagnosticPort } from "./windowsRuntimeHostNativePorts";

export function readWindowsShortcutDiagnostic(
  parentNativeHostId: number, addon: WindowsRuntimeShortcutOwnerDiagnosticPort | null
): WindowsRuntimeShortcutOwnerDiagnostic | null {
  if (process.platform !== "win32") return null;
  if (!Number.isSafeInteger(parentNativeHostId) || parentNativeHostId < 1) {
    throw new RionBridgeError({
      code: "ELECTRON_RUNTIME_SHORTCUT_DIAGNOSTIC_HOST_INVALID",
      message: "The Windows shortcut diagnostic requires one exact native host."
    });
  }
  const owner = BrowserWindow.fromId(parentNativeHostId);
  if (!addon || !owner || owner.isDestroyed()) {
    throw new RionBridgeError({
      code: "ELECTRON_RUNTIME_SHORTCUT_DIAGNOSTIC_OWNER_MISSING",
      message: "The Windows shortcut diagnostic owner is no longer active."
    });
  }
  return addon.readWindowsRuntimeShortcutOwner(owner.getNativeWindowHandle());
}
