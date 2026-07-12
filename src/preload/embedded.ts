import { contextBridge, ipcRenderer } from "electron";

const MACRO_OVERLAY_REQUEST_CHANNEL = "macros:overlay-request";

contextBridge.exposeInMainWorld("rionStudioMacroOverlay", (request: unknown) =>
  ipcRenderer.invoke(MACRO_OVERLAY_REQUEST_CHANNEL, request)
);
