import { contextBridge, ipcRenderer } from "electron";

import { WORKSPACE_RESIZE_INDICATOR_CHANNEL } from "../shared/internalIpc";
import {
  isWorkspaceResizeIndicatorPayload,
  type WorkspaceResizeIndicatorPayload
} from "../shared/workspaceResize";

const MACRO_OVERLAY_REQUEST_CHANNEL = "macros:overlay-request";

contextBridge.exposeInMainWorld("rionStudioMacroOverlay", (request: unknown) =>
  ipcRenderer.invoke(MACRO_OVERLAY_REQUEST_CHANNEL, request)
);

let pendingResizeIndicatorPayload: WorkspaceResizeIndicatorPayload = { type: "hide" };
let resizeIndicatorBadge: HTMLSpanElement | undefined;
let resizeIndicatorHost: HTMLDivElement | undefined;

ipcRenderer.on(WORKSPACE_RESIZE_INDICATOR_CHANNEL, (_event, payload: unknown) => {
  if (!isWorkspaceResizeIndicatorPayload(payload)) {
    return;
  }

  pendingResizeIndicatorPayload = payload;
  applyWorkspaceResizeIndicator(payload);
});

function applyWorkspaceResizeIndicator(payload: WorkspaceResizeIndicatorPayload): void {
  if (payload.type === "hide") {
    if (resizeIndicatorHost) {
      resizeIndicatorHost.hidden = true;
      resizeIndicatorHost.style.display = "none";
    }
    return;
  }

  const badge = ensureWorkspaceResizeIndicator();
  if (!badge || !resizeIndicatorHost) {
    window.addEventListener(
      "DOMContentLoaded",
      () => applyWorkspaceResizeIndicator(pendingResizeIndicatorPayload),
      { once: true }
    );
    return;
  }

  badge.textContent = payload.label;
  resizeIndicatorHost.hidden = false;
  resizeIndicatorHost.style.display = "block";
  badge.getAnimations().forEach((animation) => animation.cancel());
  badge.animate(
    [
      { opacity: 0.82, transform: "scale(0.96)" },
      { opacity: 1, transform: "scale(1)" }
    ],
    { duration: 110, easing: "ease-out" }
  );
}

function ensureWorkspaceResizeIndicator(): HTMLSpanElement | undefined {
  if (resizeIndicatorBadge && resizeIndicatorHost?.isConnected) {
    return resizeIndicatorBadge;
  }

  if (!document.documentElement) {
    return undefined;
  }

  const host = document.createElement("div");
  host.id = "rion-studio-workspace-resize-indicator";
  host.hidden = true;
  host.style.display = "none";
  host.style.cssText = [
    "contain:layout style paint",
    "left:50%",
    "pointer-events:none",
    "position:fixed",
    "top:12px",
    "transform:translateX(-50%)",
    "z-index:2147483647"
  ].join(";");

  const shadowRoot = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .badge {
      -webkit-backdrop-filter: blur(18px) saturate(130%);
      backdrop-filter: blur(18px) saturate(130%);
      background: rgba(17, 20, 27, 0.82);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 999px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
      color: rgba(255, 255, 255, 0.96);
      display: block;
      font: 600 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0.01em;
      padding: 7px 10px;
      white-space: nowrap;
    }
  `;
  const badge = document.createElement("span");
  badge.className = "badge";
  shadowRoot.append(style, badge);
  document.documentElement.append(host);
  resizeIndicatorHost = host;
  resizeIndicatorBadge = badge;
  return badge;
}
