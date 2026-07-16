import type { BrowserWindow } from "electron";

import { IPC_CHANNELS } from "../../shared/ipc";
import type { AppWindowState } from "../../shared/types";

type AppWindowStateWindow = Pick<BrowserWindow, "isDestroyed" | "isFullScreen" | "off" | "on" | "once" | "webContents">;

export function getAppWindowState(window: Pick<BrowserWindow, "isFullScreen">): AppWindowState {
  return { fullscreen: window.isFullScreen() };
}

export function bindAppWindowStateBroadcast(window: AppWindowStateWindow): () => void {
  const broadcast = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(IPC_CHANNELS.appWindowStateChanged, getAppWindowState(window));
  };
  const cleanup = (): void => {
    window.off("enter-full-screen", broadcast);
    window.off("leave-full-screen", broadcast);
  };

  window.on("enter-full-screen", broadcast);
  window.on("leave-full-screen", broadcast);
  window.once("closed", cleanup);

  return cleanup;
}
