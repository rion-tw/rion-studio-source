import { contextBridge, ipcRenderer } from "electron";

import {
  EMBEDDED_RUNTIME_DIAGNOSTICS_CHANNEL,
  type EmbeddedRuntimeDiagnosticPayload,
  type EmbeddedRuntimeLifecycleEvent
} from "../shared/embeddedRuntimeDiagnostics";
import { installDocumentStorageSeedAtDocumentStart } from "./documentStorageSeed";
import {
  isWorkspaceResizeIndicatorPayload,
  type WorkspaceResizeIndicatorPayload
} from "../shared/workspaceResize";

const MACRO_OVERLAY_REQUEST_CHANNEL = "macros:overlay-request";
const DIAGNOSTIC_HEARTBEAT_INTERVAL_MS = 15_000;
// Keep these literals aligned with src/shared/internalIpc.ts. Sandboxed Electron
// preloads cannot require Rollup's shared relative chunks at runtime.
const EMBEDDED_DOCUMENT_STORAGE_ACK_CHANNEL:
  typeof import("../shared/internalIpc").EMBEDDED_DOCUMENT_STORAGE_ACK_CHANNEL =
    "embedded:document-storage-ack";
const EMBEDDED_DOCUMENT_STORAGE_SEED_CHANNEL:
  typeof import("../shared/internalIpc").EMBEDDED_DOCUMENT_STORAGE_SEED_CHANNEL =
    "embedded:document-storage-seed";
const WORKSPACE_RESIZE_INDICATOR_CHANNEL:
  typeof import("../shared/internalIpc").WORKSPACE_RESIZE_INDICATOR_CHANNEL =
    "workspace:resize-indicator";

let diagnosticSequence = 0;

installDocumentStorageSeedAtDocumentStart(window, () => window.localStorage, () => window.sessionStorage, (origin) =>
  ipcRenderer.sendSync(EMBEDDED_DOCUMENT_STORAGE_SEED_CHANNEL, { origin }),
  (acknowledgement) => ipcRenderer.send(EMBEDDED_DOCUMENT_STORAGE_ACK_CHANNEL, acknowledgement)
);

function diagnosticPageState() {
  return {
    hasFocus: document.hasFocus(),
    hidden: document.hidden,
    monotonicMs: performance.now(),
    sequence: diagnosticSequence++,
    visibilityState: document.visibilityState,
    wasDiscarded: Boolean((document as Document & { wasDiscarded?: boolean }).wasDiscarded)
  };
}

function sendEmbeddedDiagnostic(payload: EmbeddedRuntimeDiagnosticPayload): void {
  ipcRenderer.send(EMBEDDED_RUNTIME_DIAGNOSTICS_CHANNEL, payload);
}

function reportLifecycle(
  event: EmbeddedRuntimeLifecycleEvent,
  graphics: { webglRenderer?: string; webglVendor?: string } = {}
): void {
  sendEmbeddedDiagnostic({
    type: "lifecycle",
    event,
    ...diagnosticPageState(),
    ...graphics
  });
}

function readWebGlGraphics(): { webglRenderer?: string; webglVendor?: string } {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const extension = context?.getExtension("WEBGL_debug_renderer_info");
    if (!context || !extension) return {};
    return {
      webglRenderer: String(context.getParameter(extension.UNMASKED_RENDERER_WEBGL) ?? "").slice(0, 512),
      webglVendor: String(context.getParameter(extension.UNMASKED_VENDOR_WEBGL) ?? "").slice(0, 512)
    };
  } catch {
    return {};
  }
}

(["focus", "blur", "pageshow", "pagehide"] as const).forEach((event) => {
  window.addEventListener(event, () => reportLifecycle(event), true);
});
(["freeze", "resume"] as const).forEach((event) => {
  document.addEventListener(event, () => reportLifecycle(event), true);
});
document.addEventListener("visibilitychange", () => reportLifecycle("visibilitychange"), true);
document.addEventListener("webglcontextlost", () => {
  sendEmbeddedDiagnostic({ type: "webgl", event: "context_lost", ...diagnosticPageState() });
}, true);
document.addEventListener("webglcontextrestored", () => {
  sendEmbeddedDiagnostic({ type: "webgl", event: "context_restored", ...diagnosticPageState() });
}, true);

window.setInterval(() => {
  sendEmbeddedDiagnostic({ type: "heartbeat", ...diagnosticPageState() });
}, DIAGNOSTIC_HEARTBEAT_INTERVAL_MS);

const installDiagnostics = (): void => {
  reportLifecycle("install", readWebGlGraphics());
  sendEmbeddedDiagnostic({ type: "heartbeat", ...diagnosticPageState() });
};
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", installDiagnostics, { once: true });
} else {
  installDiagnostics();
}

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
