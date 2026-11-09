import { type JSX, useEffect, useRef, useState } from "react";

import { Slider } from "../../components/ui/slider";
import { Switch } from "../../components/ui/switch";
import { SettingsRow } from "../../components/ui/patterns";
import type { TranslationKey, Translator } from "../../i18n";
import { normalizeGameBrowserSettings } from "../../../../shared/browserFonts";
import {
  GAME_EFFECT_DENSITIES,
  GAME_EFFECT_LEVELS,
  gameEffectSettingsEqual,
  type GameEffectLevel,
  type GameEffectSettings
} from "../../../../shared/gameEffects";
import type { GameBrowserSettings, GameBrowserSettingsPatch } from "../../../../shared/types";

interface GameEffectsSettingsRowsProps {
  settings: GameBrowserSettings;
  t: Translator;
  onError: (error: unknown) => void;
  onSave: (patch: GameBrowserSettingsPatch) => Promise<GameBrowserSettings>;
}

const gameEffectLevelLabelKeys: Readonly<Record<GameEffectLevel, TranslationKey>> = Object.freeze({
  none: "settings.gameEffectsLevelNone",
  light: "settings.gameEffectsLevelLight",
  medium: "settings.gameEffectsLevelMedium",
  heavy: "settings.gameEffectsLevelHeavy",
  hidden: "settings.gameEffectsLevelHidden"
});

/**
 * Optimistic rows: the draft follows every control at once and saves the
 * newest complete value; a failed save restores the last persisted value.
 */
export function GameEffectsSettingsRows({ settings, t, onError, onSave }: GameEffectsSettingsRowsProps): JSX.Element {
  const persisted = normalizeGameBrowserSettings(settings).effects;
  const [draft, setDraft] = useState<GameEffectSettings>(persisted);
  const [enabledThisSession, setEnabledThisSession] = useState(false);
  const savingRef = useRef(false);
  const queuedRef = useRef<GameEffectSettings | null>(null);
  const persistedRef = useRef(persisted);

  useEffect(() => {
    persistedRef.current = persisted;
    if (!savingRef.current && !queuedRef.current) setDraft(persisted);
    // The persisted record identity changes with every snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persisted.enabled, persisted.level, persisted.dimBrightSkills, persisted.hideHitEffects, persisted.density]);

  function save(next: GameEffectSettings): void {
    if (savingRef.current) {
      queuedRef.current = next;
      return;
    }
    savingRef.current = true;
    void onSave({ effects: next })
      .then((saved) => {
        persistedRef.current = normalizeGameBrowserSettings(saved).effects;
      })
      .catch((error: unknown) => {
        queuedRef.current = null;
        setDraft(persistedRef.current);
        onError(error);
      })
      .finally(() => {
        savingRef.current = false;
        const queued = queuedRef.current;
        queuedRef.current = null;
        if (queued && !gameEffectSettingsEqual(queued, persistedRef.current)) save(queued);
      });
  }

  function update(change: Partial<GameEffectSettings>): void {
    const next = { ...draft, ...change };
    if (gameEffectSettingsEqual(next, draft)) return;
    if (change.enabled === true && !persistedRef.current.enabled) setEnabledThisSession(true);
    setDraft(next);
    save(next);
  }

  const levelIndex = Math.max(0, GAME_EFFECT_LEVELS.indexOf(draft.level));
  const densityIndex = Math.max(0, GAME_EFFECT_DENSITIES.indexOf(draft.density));

  return (
    <>
      <SettingsRow
        title={t("settings.gameEffectsEnabled")}
        description={
          <>
            {t("settings.gameEffectsEnabledDescription")}
            {enabledThisSession && draft.enabled ? (
              <span className="mt-1 block font-medium text-foreground" role="status">
                {t("settings.gameEffectsReloadHint")}
              </span>
            ) : null}
          </>
        }
        control={
          <Switch
            aria-label={t("settings.gameEffectsEnabled")}
            checked={draft.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        }
      />
      <SettingsRow
        title={t("settings.gameEffectsLevel")}
        description={t("settings.gameEffectsLevelDescription")}
        control={
          <div className="grid w-full min-w-[240px] gap-1.5 sm:w-[320px]">
            <div className="flex items-center gap-3">
              <Slider
                aria-label={t("settings.gameEffectsLevel")}
                aria-valuetext={t(gameEffectLevelLabelKeys[draft.level])}
                disabled={!draft.enabled}
                max={GAME_EFFECT_LEVELS.length - 1}
                min={0}
                step={1}
                value={[levelIndex]}
                onValueChange={([index]) => {
                  const level = typeof index === "number" ? GAME_EFFECT_LEVELS[index] : undefined;
                  if (level) update({ level });
                }}
              />
              <output className="w-14 shrink-0 text-right text-xs font-semibold text-muted-foreground">
                {t(gameEffectLevelLabelKeys[draft.level])}
              </output>
            </div>
          </div>
        }
      />
      <SettingsRow
        title={t("settings.gameEffectsDensity")}
        description={t("settings.gameEffectsDensityDescription")}
        control={
          <div className="grid w-full min-w-[240px] gap-1.5 sm:w-[320px]">
            <div className="flex items-center gap-3">
              <Slider
                aria-label={t("settings.gameEffectsDensity")}
                aria-valuetext={`${draft.density}%`}
                disabled={!draft.enabled}
                max={GAME_EFFECT_DENSITIES.length - 1}
                min={0}
                step={1}
                value={[densityIndex]}
                onValueChange={([index]) => {
                  const density = typeof index === "number" ? GAME_EFFECT_DENSITIES[index] : undefined;
                  if (density) update({ density });
                }}
              />
              <output className="w-14 shrink-0 text-right text-xs font-semibold text-muted-foreground">
                {`${draft.density}%`}
              </output>
            </div>
          </div>
        }
      />
      <SettingsRow
        title={t("settings.gameEffectsBrightSkills")}
        description={t("settings.gameEffectsBrightSkillsDescription")}
        control={
          <Switch
            aria-label={t("settings.gameEffectsBrightSkills")}
            checked={draft.dimBrightSkills}
            disabled={!draft.enabled}
            onCheckedChange={(dimBrightSkills) => update({ dimBrightSkills })}
          />
        }
      />
      <SettingsRow
        showDivider={false}
        title={t("settings.gameEffectsHideHits")}
        description={t("settings.gameEffectsHideHitsDescription")}
        control={
          <Switch
            aria-label={t("settings.gameEffectsHideHits")}
            checked={draft.hideHitEffects}
            disabled={!draft.enabled}
            onCheckedChange={(hideHitEffects) => update({ hideHitEffects })}
          />
        }
      />
    </>
  );
}
