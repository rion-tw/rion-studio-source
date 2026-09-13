import type { CoreErrorPayload, ChromiumRoleOverlayResultRecord } from "../../shared/generated";
import { normalizeRionBridgeError } from "./errors";

export type ChromiumRoleOverlayResult = ChromiumRoleOverlayResultRecord;

const ADMISSION_REJECTIONS = new Set([
  "MACRO_ROLE_INPUT_FENCED", "MACRO_ROLE_INPUT_RECOVERING",
  "MACRO_ROLE_INPUT_RESTART_REQUIRED", "ELECTRON_MANAGED_SHORTCUT_SUPERSEDED",
  "ELECTRON_MANAGED_SHORTCUT_DUPLICATE"
]);

/** Preserve structured domain refusal across Electron's exception boundary. */
export async function captureChromiumRoleOverlayResult(
  operation: () => Promise<unknown>,
  reportFailure: (error: CoreErrorPayload) => void
): Promise<ChromiumRoleOverlayResult> {
  try {
    return { outcome: "success", value: await operation() };
  } catch (cause) {
    const error = normalizeRionBridgeError(cause);
    const outcome = ADMISSION_REJECTIONS.has(error.code) ? "rejected" : "failed";
    if (outcome === "failed") reportFailure(error);
    return { outcome, error };
  }
}
