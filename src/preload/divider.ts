import { contextBridge, ipcRenderer } from "electron";

const DIVIDER_POINTER_CHANNEL = "game-divider:pointer";

contextBridge.exposeInMainWorld("rionStudioDivider", {
  sendPointer: (payload: unknown) => ipcRenderer.send(DIVIDER_POINTER_CHANNEL, payload)
});
