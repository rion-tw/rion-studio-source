import type { AppKitWorkspaceAppearanceObservationReceiptRecord } from
  "../../shared/generated";
import { runtimeError } from "./chromiumRuntimeEffectExecutorSupport";

interface AppKitWorkspaceAppearanceObserver {
  observe: (
    windowIds: readonly string[]
  ) => AppKitWorkspaceAppearanceObservationReceiptRecord;
}

export function observeAppKitWorkspaceAppearance(
  observer: AppKitWorkspaceAppearanceObserver | undefined,
  windowIds: readonly string[],
  hasWindow: (windowId: string) => boolean
): AppKitWorkspaceAppearanceObservationReceiptRecord {
  if (windowIds.length < 1 || windowIds.length > 128 ||
      new Set(windowIds).size !== windowIds.length ||
      windowIds.some((windowId) => !hasWindow(windowId))) {
    throw runtimeError(
      "ELECTRON_MACOS_APPKIT_WORKSPACE_APPEARANCE_TARGET_INVALID",
      "Core requested an invalid AppKit workspace-appearance observation set."
    );
  }
  if (!observer) {
    throw runtimeError(
      "ELECTRON_MACOS_APPKIT_WORKSPACE_APPEARANCE_UNAVAILABLE",
      "The exact AppKit workspace-appearance observation source is unavailable."
    );
  }
  return observer.observe(windowIds);
}
