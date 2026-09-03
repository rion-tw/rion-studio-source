import { contextBridge, ipcRenderer, webFrame } from "electron";

import { installChromiumRoleFonts } from "./installChromiumRoleFonts";
import { installChromiumRoleOverlay } from "./installChromiumRoleOverlay";
import {
  createChromiumRoleTrustedInputOverlayGuard,
  installChromiumRoleTrustedInput
} from
  "./installChromiumRoleTrustedInput";

// Remote content receives no main-world bridge, Node API, Electron object, or
// generic invoke. Browser-font bytes cross only the sandboxed preload and are
// consumed from a one-shot main-world data slot by the shared DOM/Canvas
// runtime. Its exact receipt is generation/document-fenced in main.
void installChromiumRoleFonts(
  ipcRenderer,
  webFrame,
  process.isMainFrame
).catch(() => undefined);
// The macro overlay runs only in isolated world 1004 and calls a fixed,
// main-frame-authenticated IPC surface through named wrappers.
void installChromiumRoleOverlay(
  contextBridge,
  ipcRenderer,
  webFrame,
  process.isMainFrame,
  process.platform
).catch(() => undefined);
installChromiumRoleTrustedInput(
  ipcRenderer,
  webFrame.frameToken,
  process.isMainFrame,
  undefined,
  createChromiumRoleTrustedInputOverlayGuard(webFrame)
);
