import type {
  AppKitRuntimeTabProjectionRecord,
  ChromiumPopupAdmissionRecord,
  ChromiumPopupNativeHostReceiptRecord,
  EmbeddedLaunchTargetRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumPopupHostLifecycleObserver } from "./chromiumPopupPorts";
import type { ChromiumRuntimeHostPort } from "./chromiumRuntimeEffectExecutor";
import {
  validateChromiumPopupHostAdmission,
  type ChromiumRuntimePopupHostHandle
} from "./chromiumRuntimeHostFactory";

function popupError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

export async function createMacosAppKitPopupHost(
  admission: ChromiumPopupAdmissionRecord,
  create: (
    target: EmbeddedLaunchTargetRecord,
    launchGeneration: string,
    popupAdmission: ChromiumPopupAdmissionRecord
  ) => Promise<ChromiumRuntimeHostPort>
): Promise<ChromiumRuntimePopupHostHandle> {
  validateChromiumPopupHostAdmission(admission);
  const host = await create(
    admission.target,
    admission.openOperationId,
    admission
  );
  const identity = host.appKitIdentity;
  if (!identity || host.isDestroyed() || host.isVisible()) {
    if (!host.isDestroyed()) await host.close();
    throw popupError(
      "ELECTRON_MACOS_APPKIT_POPUP_HOST_INVALID",
      "The retained AppKit popup host did not preserve its exact hidden identity."
    );
  }
  const receipt: ChromiumPopupNativeHostReceiptRecord = Object.freeze({
    platform: "macos",
    nativeHostId: host.id,
    logicalWindowId: admission.target.windowId,
    windowGeneration: 1,
    topologyRevision: 1,
    appkitIdentity: identity
  });
  return Object.freeze({ host, receipt });
}

export function popupTabProjection(
  admission: ChromiumPopupAdmissionRecord
): AppKitRuntimeTabProjectionRecord {
  return Object.freeze({
    tabId: admission.popupId,
    name: admission.title,
    phase: "ready",
    tabType: "popup",
    audioMuted: false
  });
}

export function bindPopupObserver(
  current: ChromiumPopupHostLifecycleObserver | null,
  observer: ChromiumPopupHostLifecycleObserver
): ChromiumPopupHostLifecycleObserver {
  if (
    !observer || typeof observer.closeRequested !== "function" ||
    typeof observer.closed !== "function" ||
    typeof observer.layoutChanged !== "function"
  ) {
    throw popupError(
      "ELECTRON_MACOS_APPKIT_POPUP_OBSERVER_INVALID",
      "The AppKit popup requires exact native lifecycle observers."
    );
  }
  if (current) {
    throw popupError(
      "ELECTRON_MACOS_APPKIT_POPUP_OBSERVER_ALREADY_BOUND",
      "The AppKit popup lifecycle observer is already bound."
    );
  }
  return observer;
}

export type MacosPopupAction = "focus" | "close" | "layout" | "ignore" | "reject";

export function classifyMacosPopupAction(
  popupId: string,
  action: Readonly<Record<string, unknown>>
): MacosPopupAction {
  if (action.type === "activate" && action.tabId === popupId) return "focus";
  if (
    action.type === "stop" && action.tabId === popupId ||
    action.type === "closeWindow"
  ) return "close";
  if (
    action.type === "layout" || action.type === "windowState" ||
    action.type === "windowPlacementChanged"
  ) return "layout";
  if (action.type === "windowFocusChanged") return "ignore";
  return "reject";
}
