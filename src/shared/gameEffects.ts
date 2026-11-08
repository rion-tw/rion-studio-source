import type { GameEffectSettingsRecord } from "./generated";

export type GameEffectSettings = GameEffectSettingsRecord;
export type GameEffectLevel = GameEffectSettingsRecord["level"];

/**
 * Discrete stops instead of a percentage: screen blending saturates stacked
 * effects, so neighbouring percentages look identical. Each stop is roughly a
 * third of the previous one. `none` keeps ordinary effects untouched and only
 * applies the bright-skill list, darkening effects and hidden hit effects.
 */
export const GAME_EFFECT_LEVELS = [
  "none",
  "light",
  "medium",
  "heavy",
  "hidden"
] as const satisfies readonly GameEffectLevel[];

export const GAME_EFFECT_LEVEL_BRIGHTNESS: Readonly<Record<GameEffectLevel, number>> =
  Object.freeze({ none: 1, light: 0.7, medium: 0.25, heavy: 0.08, hidden: 0 });

export const DEFAULT_GAME_EFFECT_SETTINGS: GameEffectSettings = Object.freeze({
  enabled: false,
  level: "medium",
  dimBrightSkills: true,
  hideHitEffects: false
});

/** The page-runtime projection: brightness 1 with no extras is a no-op. */
export interface GameEffectRuntimeSettings {
  readonly enabled: boolean;
  readonly brightness: number;
  readonly dimBrightSkills: boolean;
  readonly hideHitEffects: boolean;
}

export function isGameEffectLevel(value: unknown): value is GameEffectLevel {
  return typeof value === "string" &&
    (GAME_EFFECT_LEVELS as readonly string[]).includes(value);
}

export function normalizeGameEffectSettings(
  value: unknown,
  fallback: GameEffectSettings = DEFAULT_GAME_EFFECT_SETTINGS
): GameEffectSettings {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : fallback.enabled,
    level: isGameEffectLevel(input.level) ? input.level : fallback.level,
    dimBrightSkills: typeof input.dimBrightSkills === "boolean"
      ? input.dimBrightSkills
      : fallback.dimBrightSkills,
    hideHitEffects: typeof input.hideHitEffects === "boolean"
      ? input.hideHitEffects
      : fallback.hideHitEffects
  };
}

export function gameEffectSettingsEqual(left: GameEffectSettings, right: GameEffectSettings): boolean {
  return left.enabled === right.enabled && left.level === right.level &&
    left.dimBrightSkills === right.dimBrightSkills &&
    left.hideHitEffects === right.hideHitEffects;
}

/** Disabled settings project to a pure pass-through for already hooked pages. */
export function gameEffectRuntimeSettings(settings: GameEffectSettings): GameEffectRuntimeSettings {
  if (!settings.enabled) {
    return Object.freeze({ enabled: false, brightness: 1, dimBrightSkills: false, hideHitEffects: false });
  }
  return Object.freeze({
    enabled: true,
    brightness: GAME_EFFECT_LEVEL_BRIGHTNESS[settings.level],
    dimBrightSkills: settings.dimBrightSkills,
    hideHitEffects: settings.hideHitEffects
  });
}

export function isGameEffectRuntimeSettings(value: unknown): value is GameEffectRuntimeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4 && typeof record.enabled === "boolean" &&
    typeof record.brightness === "number" && Number.isFinite(record.brightness) &&
    record.brightness >= 0 && record.brightness <= 1 &&
    typeof record.dimBrightSkills === "boolean" && typeof record.hideHitEffects === "boolean";
}
