import { contextBridge, ipcRenderer, webFrame } from "electron";

import { installChromiumRoleFonts } from "./installChromiumRoleFonts";
import { installChromiumRoleOverlay } from "./installChromiumRoleOverlay";
import { installChromiumRolePagePresentation } from "./installChromiumRolePagePresentation";
import {
  createChromiumRoleTrustedInputOverlayGuard,
  installChromiumRoleTrustedInput
} from
  "./installChromiumRoleTrustedInput";

// Effect dimming must hook WebGL before the game compiles its shaders, so it
// installs synchronously first. Its setter stays in this isolated world.
installChromiumRolePagePresentation({
  contextBridge,
  ipc: ipcRenderer,
  webFrame,
  isMainFrame: process.isMainFrame
});

// Remote content receives no main-world bridge, Node API, Electron object, or
// generic invoke. Browser-font bytes cross only the sandboxed preload and are
// consumed from a one-shot main-world data slot by the shared DOM/Canvas
// runtime. Its exact receipt is generation/document-fenced in main.
void installChromiumRoleFonts(
  ipcRenderer,
  webFrame,
  process.isMainFrame
).catch(() => undefined);
// Observe before the overlay installs capture listeners that consume bound shortcuts.
installChromiumRoleTrustedInput(
  ipcRenderer,
  webFrame.frameToken,
  process.isMainFrame,
  undefined,
  createChromiumRoleTrustedInputOverlayGuard(webFrame)
);

// The macro overlay runs only in isolated world 1004 and calls a fixed,
// main-frame-authenticated IPC surface through named wrappers.
void installChromiumRoleOverlay(
  contextBridge,
  ipcRenderer,
  webFrame,
  process.isMainFrame,
  process.platform
).catch(() => undefined);
