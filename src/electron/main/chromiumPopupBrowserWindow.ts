import { randomUUID } from "node:crypto";

import type {
  ChromiumPopupAdmissionRecord,
  ChromiumPopupOpenRequestRecord,
  ChromiumPopupParentFenceRecord,
  EmbeddedLaunchTargetRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumPopupHostLifecycleObserver,
  ChromiumPopupPostBody,
  ChromiumPopupWindowPort,
  ChromiumWindowOpenDetails
} from "./chromiumPopupPorts";
import type {
  ChromiumRoleSurfaceEvent,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort
} from "./chromiumRoleSurfacePorts";
import type { ChromiumRuntimeHostPort } from
  "./chromiumRuntimeEffectExecutor";

export function buildChromiumPopupOpenRequest(
  details: ChromiumWindowOpenDetails,
  resolution: Readonly<{
    parent: ChromiumPopupParentFenceRecord;
    parentTarget: EmbeddedLaunchTargetRecord;
  }>,
  hasPostBody: boolean,
  openerPolicy: ChromiumPopupOpenRequestRecord["openerPolicy"] =
    "isolatedNoopener"
): ChromiumPopupOpenRequestRecord {
  const referrerUrl = details.referrer?.url || undefined;
  const referrerPolicy = details.referrer?.policy || undefined;
  return Object.freeze({
    requestId: randomUUID(),
    parent: resolution.parent,
    parentTarget: resolution.parentTarget,
    targetUrl: details.url,
    disposition: "newWindow",
    openerPolicy,
    ...(details.frameName ? { frameName: details.frameName } : {}),
    ...(referrerUrl ? { referrerUrl } : {}),
    ...(referrerPolicy ? { referrerPolicy } : {}),
    rawFeatures: details.features ?? "",
    hasPostBody
  });
}

export function chromiumPopupLoadOptions(
  admission: ChromiumPopupAdmissionRecord,
  postBody: ChromiumPopupPostBody | undefined
): Parameters<ChromiumRoleSurfaceWebContentsPort["loadURL"]>[1] {
  const httpReferrer = admission.referrerUrl
    ? {
        url: admission.referrerUrl,
        policy: admission.referrerPolicy ?? "default"
      }
    : undefined;
  if (!postBody) return httpReferrer ? { httpReferrer } : undefined;
  const contentType = postBody.contentType === "multipart/form-data"
    ? `${postBody.contentType}; boundary=${postBody.boundary!}`
    : postBody.contentType;
  return {
    ...(httpReferrer ? { httpReferrer } : {}),
    extraHeaders: `Content-Type: ${contentType}`,
    postData: [...postBody.data]
  };
}

const PRESENTATION_FEATURES = new Set([
  "width", "height", "left", "top", "screenx", "screeny", "outerwidth",
  "outerheight", "popup", "toolbar", "location", "status", "menubar",
  "scrollbars", "resizable", "copyhistory", "noopener", "noreferrer"
]);

export function canonicalChromiumPopupRemoteUrl(value: unknown): string | null {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 8_192 ||
    value !== value.trim() || value.includes("\\") || /\s/u.test(value)
  ) return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname.length === 0 || parsed.username.length > 0 ||
      parsed.password.length > 0 || parsed.href !== value
    ) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function supportedFrameName(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "_blank") return true;
  if (
    value.length > 128 ||
    ["_self", "_parent", "_top"].includes(value.toLowerCase())
  ) return false;
  return /^[A-Za-z0-9_.:-]+$/u.test(value);
}

function supportedFeatures(raw: string): boolean {
  if (raw.length > 1_024) return false;
  return raw.split(",").map((feature) => feature.trim()).every((feature) => {
    if (feature.length === 0) return true;
    const separator = feature.indexOf("=");
    const name = (separator < 0 ? feature : feature.slice(0, separator))
      .trim().toLowerCase();
    const value = separator < 0 ? null : feature.slice(separator + 1).trim();
    return PRESENTATION_FEATURES.has(name) && (value === null ||
      value.length > 0 && value.length <= 32 && /^[A-Za-z0-9+.-]+$/u.test(value));
  });
}

export function chromiumPopupRequestsNoopener(raw = ""): boolean {
  return raw.split(",").some((feature) => {
    const name = feature.split("=", 1)[0]?.trim().toLowerCase();
    return name === "noopener" || name === "noreferrer";
  });
}

export function supportedChromiumWindowOpen(
  details: ChromiumWindowOpenDetails
): boolean {
  return (details.disposition === "foreground-tab" ||
      details.disposition === "new-window") &&
    details.url !== "about:blank" && details.url.length <= 8_192 &&
    supportedFrameName(details.frameName) &&
    supportedFeatures(details.features ?? "");
}

export function trustedChromiumPopupTitle(value: string): string {
  const url = canonicalChromiumPopupRemoteUrl(value);
  return `Rion Popup — ${url ? new URL(url).hostname : "Loading"}`;
}

function popupError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

/** Adapts one standard BrowserWindow without introducing another native host. */
export function createChromiumPopupBrowserWindowHost(
  admission: ChromiumPopupAdmissionRecord,
  popupWindow: ChromiumPopupWindowPort
): Readonly<{
  host: ChromiumRuntimeHostPort;
  view: ChromiumRoleWebContentsViewPort;
}> {
  let observer: ChromiumPopupHostLifecycleObserver | null = null;
  let forceClosing = false;
  const close = (event: ChromiumRoleSurfaceEvent) => {
    if (forceClosing) return;
    event.preventDefault();
    observer?.closeRequested();
  };
  const closed = () => observer?.closed();
  const layout = () => {
    if (!popupWindow.isDestroyed()) {
      observer?.layoutChanged(popupWindow.getContentBounds());
    }
  };
  const host: ChromiumRuntimeHostPort = {
    id: popupWindow.id,
    logicalWindowId: admission.target.windowId,
    contentView: {
      addChildView: () => undefined,
      removeChildView: () => undefined
    },
    bindPopupLifecycle: (candidate) => {
      if (observer) {
        throw popupError(
          "ELECTRON_CHROMIUM_POPUP_OBSERVER_ALREADY_BOUND",
          "The Electron popup lifecycle observer is already bound."
        );
      }
      observer = candidate;
      popupWindow.on("close", close);
      popupWindow.on("closed", closed);
      popupWindow.on("move", layout);
      popupWindow.on("resize", layout);
    },
    close: async () => {
      if (popupWindow.isDestroyed()) return;
      forceClosing = true;
      popupWindow.destroy();
    },
    focus: () => popupWindow.focus(),
    hide: () => popupWindow.hide(),
    getContentBounds: () => popupWindow.getContentBounds(),
    readProjection: () => ({
      displayId: admission.target.displayId,
      bounds: popupWindow.getBounds(),
      visible: popupWindow.isVisible(),
      focused: popupWindow.isFocused(),
      presentation: "normal"
    }),
    isDestroyed: () => popupWindow.isDestroyed(),
    isVisible: () => popupWindow.isVisible(),
    show: () => {
      popupWindow.setFocusable(true);
      popupWindow.show();
    },
    showInactive: () => popupWindow.showInactive()
  };
  return Object.freeze({
    host,
    view: {
      webContents: popupWindow.webContents,
      getBounds: () => popupWindow.getContentBounds(),
      getVisible: () => popupWindow.isVisible(),
      setBounds: () => undefined,
      setVisible: () => undefined
    }
  });
}
