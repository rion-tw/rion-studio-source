import { contextBridge, ipcRenderer } from "electron";

import { installRionStudioPreloadBridge } from "../preload/installRionStudioBridge";
import { installElectronDesktopE2ePreloadBridge } from "./desktopE2eBridge";

installRionStudioPreloadBridge(contextBridge, ipcRenderer);
installElectronDesktopE2ePreloadBridge(contextBridge, ipcRenderer);
