import type { ChromiumRoleOverlayEnvelope } from
  "../ipc/chromiumRoleOverlayProtocol";
import {
  CHROMIUM_ROLE_OVERLAY_API_KEY,
  CHROMIUM_ROLE_OVERLAY_CHANNEL,
  CHROMIUM_ROLE_OVERLAY_WORLD_ID,
  CHROMIUM_ROLE_OVERLAY_WORLD_NAME
} from "../ipc/chromiumRoleOverlayProtocol";
import { assembleChromiumRoleOverlaySource } from "./chromiumRoleOverlaySource";

export interface ChromiumRoleOverlayIpcRendererPort {
  invoke: (channel: string, envelope: ChromiumRoleOverlayEnvelope) => Promise<unknown>;
}

export interface ChromiumRoleOverlayContextBridgePort {
  exposeInIsolatedWorld: (worldId: number, apiKey: string, api: object) => void;
}

export interface ChromiumRoleOverlayWebFramePort {
  readonly frameToken: string;
  executeJavaScriptInIsolatedWorld: (
    worldId: number,
    scripts: Array<{ code: string; url?: string }>,
    userGesture?: boolean
  ) => Promise<unknown>;
  setIsolatedWorldInfo: (
    worldId: number,
    info: Readonly<{ csp: string; name: string; securityOrigin: string }>
  ) => void;
}

function invoke(
  ipc: ChromiumRoleOverlayIpcRendererPort,
  frameToken: string,
  envelope: ChromiumRoleOverlayEnvelope
): Promise<unknown> {
  return ipc.invoke(CHROMIUM_ROLE_OVERLAY_CHANNEL, Object.freeze({
    ...envelope,
    frameToken
  }));
}

export function createChromiumRoleOverlayApi(
  ipc: ChromiumRoleOverlayIpcRendererPort,
  frameToken: string,
  platform: NodeJS.Platform = process.platform
) {
  if (
    typeof frameToken !== "string" ||
    frameToken.length === 0 ||
    frameToken.length > 128 ||
    frameToken !== frameToken.trim()
  ) {
    throw new Error("The Chromium role overlay requires an exact frame token.");
  }
  return Object.freeze({
    frameToken,
    request: (payload: unknown) =>
      invoke(ipc, frameToken, { frameToken, method: "request", payload }),
    ready: () => invoke(ipc, frameToken, { frameToken, method: "ready" }),
    refreshReceipt: (payload: unknown) =>
      invoke(ipc, frameToken, { frameToken, method: "refreshReceipt", payload }),
    macroKeyObserved: (payload: unknown) =>
      invoke(ipc, frameToken, { frameToken, method: "macroKeyObserved", payload }),
    managedShortcutKeyPhase: (payload: unknown) =>
      invoke(ipc, frameToken, {
        frameToken,
        method: "managedShortcutKeyPhase",
        payload
      }),
    ...(platform === "win32"
      ? {
          inputContextLost: (payload: unknown) =>
            invoke(ipc, frameToken, {
              frameToken,
              method: "inputContextLost",
              payload
            })
        }
      : {}),
    macroBadgeTiming: (payload: unknown) =>
      invoke(ipc, frameToken, { frameToken, method: "macroBadgeTiming", payload })
  });
}

export async function installChromiumRoleOverlay(
  contextBridge: ChromiumRoleOverlayContextBridgePort,
  ipc: ChromiumRoleOverlayIpcRendererPort,
  webFrame: ChromiumRoleOverlayWebFramePort,
  isMainFrame: boolean,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (!isMainFrame) return false;
  webFrame.setIsolatedWorldInfo(CHROMIUM_ROLE_OVERLAY_WORLD_ID, {
    csp: [
      "default-src 'none'",
      "script-src blob:",
      "style-src 'unsafe-inline'",
      "font-src data:",
      "img-src data: blob:"
    ].join("; "),
    name: CHROMIUM_ROLE_OVERLAY_WORLD_NAME,
    securityOrigin: "https://rion-overlay.invalid"
  });
  contextBridge.exposeInIsolatedWorld(
    CHROMIUM_ROLE_OVERLAY_WORLD_ID,
    CHROMIUM_ROLE_OVERLAY_API_KEY,
    createChromiumRoleOverlayApi(ipc, webFrame.frameToken, platform)
  );
  await webFrame.executeJavaScriptInIsolatedWorld(
    CHROMIUM_ROLE_OVERLAY_WORLD_ID,
    [{
      code: assembleChromiumRoleOverlaySource(),
      url: "rion-studio://chromium-role-overlay.js"
    }],
    false
  );
  // The overlay's authenticated `ready` IPC event, not this Promise, is the
  // authoritative installation acknowledgement.
  return true;
}
