import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
  ChromiumPopupOpenRequestRecord,
  ChromiumPopupOpenerPolicy
} from "../../shared/generated";
import type {
  ChromiumPopupBrowserWindowOptions,
  ChromiumPopupOwnerSource,
  ChromiumWindowOpenDetails
} from "./chromiumPopupPorts";
import type { ChromiumPopupParentResolution } from "./chromiumPopupParent";
import { buildUnprivilegedRemoteContentWebPreferences } from "./security";

export function canonicalChromiumPopupRemoteUrl(value: unknown): string | null {
  if (
    typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 8_192 ||
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

export function supportedChromiumPopupFrameName(value?: string): boolean {
  if (value === undefined || value === "") return true;
  const normalized = value.toLowerCase();
  return Buffer.byteLength(value) <= 256 &&
    !/\p{Cc}/u.test(value) &&
    (!value.startsWith("_") || normalized === "_blank");
}

export function supportedChromiumWindowOpen(
  details: ChromiumWindowOpenDetails
): boolean {
  const features = details.features ?? "";
  return (
    details.disposition === "foreground-tab" ||
    details.disposition === "new-window"
  ) && details.url !== "about:blank" &&
    canonicalChromiumPopupRemoteUrl(details.url) !== null &&
    supportedChromiumPopupFrameName(details.frameName) &&
    Buffer.byteLength(features) <= 1_024 &&
    !/\p{Cc}/u.test(features);
}

export function trustedChromiumPopupTitle(value: string): string {
  const canonical = canonicalChromiumPopupRemoteUrl(value);
  return `Rion Popup — ${canonical ? new URL(canonical).hostname : "Loading"}`;
}

export function buildChromiumPopupWindowOptions(
  source: ChromiumPopupOwnerSource,
  url: string
): ChromiumPopupBrowserWindowOptions | null {
  const parent = source.parent.nativeWindow;
  if (
    !parent || parent !== source.parent.nativeWindow || parent.id !== source.parent.id ||
    parent.isDestroyed()
  ) return null;
  return Object.freeze({
    alwaysOnTop: false as const,
    autoHideMenuBar: true as const,
    closable: true as const,
    focusable: false as const,
    frame: true as const,
    fullscreen: false as const,
    fullscreenable: false as const,
    kiosk: false as const,
    modal: false as const,
    parent,
    show: false as const,
    title: trustedChromiumPopupTitle(url),
    titleBarOverlay: false as const,
    transparent: false as const,
    useContentSize: false as const,
    webPreferences: Object.freeze({
      ...buildUnprivilegedRemoteContentWebPreferences(),
      session: source.session
    })
  });
}

export function buildChromiumPopupOpenRequest(
  details: ChromiumWindowOpenDetails,
  resolution: ChromiumPopupParentResolution,
  openerPolicy: ChromiumPopupOpenerPolicy
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
    hasPostBody: details.postBody !== null && details.postBody !== undefined
  });
}
