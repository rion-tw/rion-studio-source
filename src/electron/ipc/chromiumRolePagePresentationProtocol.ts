import type { GameEffectRuntimeSettings } from "../../shared/gameEffects";

/** Synchronous at document start: shader hooks must precede game shader compilation. */
export const CHROMIUM_ROLE_GAME_EFFECTS_SYNC_CHANNEL = "rion-studio:role-game-effects-sync";
/** Role preload → main, development builds only: one draw-trace summary line. */
export const CHROMIUM_ROLE_GAME_EFFECTS_TRACE_CHANNEL = "rion-studio:role-game-effects-trace";
/** Largest accepted trace summary; larger lines are dropped. */
export const CHROMIUM_ROLE_GAME_EFFECTS_TRACE_LINE_LIMIT = 64 * 1024;

/** Synchronous document-start answer: the effect projection and whether to trace draws. */
export interface ChromiumRoleGameEffectsStart {
  readonly effects: GameEffectRuntimeSettings;
  readonly trace: boolean;
}

/** Main → role preload: live effect changes and transient runtime indicators. */
export const CHROMIUM_ROLE_PAGE_PRESENTATION_CHANNEL = "rion-studio:role-page-presentation";

export type ChromiumRolePagePresentationMessage =
  | Readonly<{ type: "effects"; settings: GameEffectRuntimeSettings }>
  | Readonly<{ type: "zoomIndicator"; label: string }>
  | Readonly<{ type: "resizeIndicator"; label: string }>
  | Readonly<{ type: "resizeIndicatorHide" }>;

const LABEL_PATTERN = /^[0-9 .%×]{1,24}$/u;

export function isChromiumRolePagePresentationMessage(
  value: unknown
): value is ChromiumRolePagePresentationMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  switch (record.type) {
    case "effects":
      return keys === "settings,type";
    case "zoomIndicator":
    case "resizeIndicator":
      return keys === "label,type" && typeof record.label === "string" &&
        LABEL_PATTERN.test(record.label);
    case "resizeIndicatorHide":
      return keys === "type";
    default:
      return false;
  }
}
