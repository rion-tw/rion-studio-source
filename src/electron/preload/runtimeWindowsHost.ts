import { contextBridge, ipcRenderer } from "electron";

import {
  isWindowsRuntimeHostProjection,
  isWindowsRuntimeHostCommand,
  WINDOWS_RUNTIME_HOST_COMMAND_CHANNEL,
  WINDOWS_RUNTIME_HOST_PROJECTION_CHANNEL,
  type WindowsRuntimeHostCommand,
  type WindowsRuntimeHostProjection
} from "../../shared/windowsRuntimeHost";

contextBridge.exposeInMainWorld("rionStudioWindowsRuntimeHost", Object.freeze({
  onProjection: (
    listener: (projection: WindowsRuntimeHostProjection) => void
  ): (() => void) => {
    if (typeof listener !== "function") {
      throw new Error("The Windows runtime-host projection listener is invalid.");
    }
    const receive = (_event: unknown, candidate: unknown): void => {
      if (!isWindowsRuntimeHostProjection(candidate)) return;
      listener(structuredClone(candidate));
    };
    ipcRenderer.on(WINDOWS_RUNTIME_HOST_PROJECTION_CHANNEL, receive);
    return () => ipcRenderer.removeListener(
      WINDOWS_RUNTIME_HOST_PROJECTION_CHANNEL,
      receive
    );
  },
  submit: (command: WindowsRuntimeHostCommand): void => {
    if (!isWindowsRuntimeHostCommand(command)) {
      throw new Error("The Windows runtime-host command is invalid.");
    }
    ipcRenderer.send(WINDOWS_RUNTIME_HOST_COMMAND_CHANNEL, structuredClone(command));
  }
}));
