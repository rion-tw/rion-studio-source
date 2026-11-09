import type { GameEffectSettingsRecord } from "./generated";

export type GameEffectSettings = GameEffectSettingsRecord;
export type GameEffectLevel = GameEffectSettingsRecord["level"];
export type GameEffectDensity = GameEffectSettingsRecord["density"];

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

/**
 * Percent of a repeated particle's copies drawn per frame. Any effect whose
 * texture repeats past the runtime threshold in one frame thins to this share;
 * effects drawn a few times are untouched. 100 draws everything.
 */
export const GAME_EFFECT_DENSITIES = [100, 75, 50, 25] as const satisfies readonly GameEffectDensity[];

export const DEFAULT_GAME_EFFECT_SETTINGS: GameEffectSettings = Object.freeze({
  enabled: false,
  level: "medium",
  dimBrightSkills: true,
  hideHitEffects: false,
  density: 100
});

/** The page-runtime projection: brightness and density 1 with no extras is a no-op. */
export interface GameEffectRuntimeSettings {
  readonly enabled: boolean;
  readonly brightness: number;
  readonly dimBrightSkills: boolean;
  readonly hideHitEffects: boolean;
  /** Share of repeated particle copies drawn, 0.25–1. */
  readonly density: number;
}

export function isGameEffectLevel(value: unknown): value is GameEffectLevel {
  return typeof value === "string" &&
    (GAME_EFFECT_LEVELS as readonly string[]).includes(value);
}

export function isGameEffectDensity(value: unknown): value is GameEffectDensity {
  return (GAME_EFFECT_DENSITIES as readonly unknown[]).includes(value);
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
      : fallback.hideHitEffects,
    density: isGameEffectDensity(input.density) ? input.density : fallback.density
  };
}

export function gameEffectSettingsEqual(left: GameEffectSettings, right: GameEffectSettings): boolean {
  return left.enabled === right.enabled && left.level === right.level &&
    left.dimBrightSkills === right.dimBrightSkills &&
    left.hideHitEffects === right.hideHitEffects && left.density === right.density;
}

/** Disabled settings project to a pure pass-through for already hooked pages. */
export function gameEffectRuntimeSettings(settings: GameEffectSettings): GameEffectRuntimeSettings {
  if (!settings.enabled) {
    return Object.freeze({
      enabled: false, brightness: 1, dimBrightSkills: false, hideHitEffects: false, density: 1
    });
  }
  return Object.freeze({
    enabled: true,
    brightness: GAME_EFFECT_LEVEL_BRIGHTNESS[settings.level],
    dimBrightSkills: settings.dimBrightSkills,
    hideHitEffects: settings.hideHitEffects,
    density: settings.density / 100
  });
}

export function isGameEffectRuntimeSettings(value: unknown): value is GameEffectRuntimeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 5 && typeof record.enabled === "boolean" &&
    typeof record.brightness === "number" && Number.isFinite(record.brightness) &&
    record.brightness >= 0 && record.brightness <= 1 &&
    typeof record.dimBrightSkills === "boolean" && typeof record.hideHitEffects === "boolean" &&
    typeof record.density === "number" && record.density >= 0.25 && record.density <= 1;
}
