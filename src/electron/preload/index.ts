import { contextBridge, ipcRenderer } from "electron";

import { installRionStudioPreloadBridge } from "./installRionStudioBridge";

installRionStudioPreloadBridge(contextBridge, ipcRenderer);
