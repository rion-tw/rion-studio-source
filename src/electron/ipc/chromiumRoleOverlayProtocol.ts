export const CHROMIUM_ROLE_OVERLAY_CHANNEL = "rion:chromium-role-overlay:v1";
export const CHROMIUM_ROLE_OVERLAY_WORLD_ID = 1004;
export const CHROMIUM_ROLE_OVERLAY_WORLD_NAME = "Rion Studio Chromium Role Overlay";
export const CHROMIUM_ROLE_OVERLAY_API_KEY = "__rionStudioChromiumRoleOverlayV1";

export const CHROMIUM_ROLE_OVERLAY_METHODS = [
  "request",
  "ready",
  "refreshReceipt",
  "macroKeyObserved",
  "managedShortcutKeyPhase",
  "inputContextLost",
  "macroBadgeTiming"
] as const;

export type ChromiumRoleOverlayMethod =
  (typeof CHROMIUM_ROLE_OVERLAY_METHODS)[number];

export interface ChromiumRoleOverlayEnvelope {
  readonly frameToken: string;
  readonly method: ChromiumRoleOverlayMethod;
  readonly payload?: unknown;
}
