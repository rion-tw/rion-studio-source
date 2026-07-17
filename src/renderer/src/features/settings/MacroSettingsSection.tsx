import { AlertTriangle, RotateCcw, Save } from "lucide-react";
import { type JSX, type ReactNode, useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Surface } from "../../components/ui/patterns";
import type { TranslationKey, Translator } from "../../i18n";
import {
  DEFAULT_MACRO_SETTINGS,
  MACRO_SETTINGS_CONSTRAINTS,
  isValidMacroSettingValue
} from "../../../../shared/macroSettings";
import type { MacroSettings } from "../../../../shared/types";

interface MacroSettingsSectionProps {
  settings: MacroSettings;
  t: Translator;
  onError: (error: unknown) => void;
  onSave: (settings: MacroSettings) => Promise<MacroSettings>;
}

type MacroSettingsDraft = Record<keyof MacroSettings, string>;

const macroSettingItems = [
  {
    key: "startupDelayMs",
    titleKey: "settings.macroStartupDelay",
    descriptionKey: "settings.macroStartupDelayDescription"
  },
  {
    key: "keyHoldMs",
    titleKey: "settings.macroKeyHold",
    descriptionKey: "settings.macroKeyHoldDescription"
  },
  {
    key: "postInputDelayMs",
    titleKey: "settings.macroPostInputDelay",
    descriptionKey: "settings.macroPostInputDelayDescription"
  },
  {
    key: "defaultLoopDelayMs",
    titleKey: "settings.macroDefaultLoopDelay",
    descriptionKey: "settings.macroDefaultLoopDelayDescription"
  }
] as const satisfies ReadonlyArray<{
  key: keyof MacroSettings;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
}>;

export function MacroSettingsSection({
  settings,
  t,
  onError,
  onSave
}: MacroSettingsSectionProps): JSX.Element {
  const [draft, setDraft] = useState<MacroSettingsDraft>(() => createMacroSettingsDraft(settings));
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const parsed = parseMacroSettingsDraft(draft);
  const isDirty = macroSettingItems.some(({ key }) => draft[key] !== String(settings[key]));

  useEffect(() => {
    setDraft(createMacroSettingsDraft(settings));
  }, [settings]);

  async function save(): Promise<void> {
    if (!parsed.settings || !isDirty || isSaving) {
      return;
    }

    setIsSaving(true);
    setMessage(null);
    try {
      const saved = await onSave(parsed.settings);
      setDraft(createMacroSettingsDraft(saved));
      setMessage(t("settings.macroSettingsSaved"));
    } catch (error) {
      onError(error);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="grid gap-2">
      <h2 className="px-1 text-xs font-semibold leading-5 text-muted-foreground">
        {t("settings.macroTiming")}
      </h2>
      <Surface className="settings-group overflow-hidden [&>*:last-child]:border-b-0" radius="md">
        {macroSettingItems.map(({ key, titleKey, descriptionKey }) => {
          const constraint = MACRO_SETTINGS_CONSTRAINTS[key];
          const value = parsed.values[key];
          const isInvalid = !isValidMacroSettingValue(key, value);
          const isBelowRecommendation = !isInvalid && value < constraint.recommendedMin;
          const description = isInvalid
            ? t("settings.macroValueRange")
                .replace("{min}", String(constraint.min))
                .replace("{max}", String(constraint.max))
            : isBelowRecommendation
              ? t("settings.macroRecommendedMinimum").replace(
                  "{value}",
                  String(constraint.recommendedMin)
                )
              : t(descriptionKey);

          return (
            <MacroSettingsRow
              key={key}
              title={t(titleKey)}
              description={
                isInvalid || isBelowRecommendation ? (
                  <span
                    className={`inline-flex items-start gap-1.5 ${
                      isInvalid
                        ? "text-destructive"
                        : "text-amber-600 dark:text-amber-300"
                    }`}
                    role={isInvalid ? "alert" : "status"}
                  >
                    <AlertTriangle className="mt-0.5 shrink-0" size={13} aria-hidden="true" />
                    {description}
                  </span>
                ) : description
              }
              control={
                <label className="flex items-center gap-2">
                  <Input
                    aria-invalid={isInvalid}
                    aria-label={t(titleKey)}
                    className={`settings-menu-control w-32 text-right tabular-nums ${
                      isInvalid ? "border-destructive/60 focus-visible:ring-destructive/25" : ""
                    }`}
                    disabled={isSaving}
                    inputMode="numeric"
                    max={constraint.max}
                    min={constraint.min}
                    step={1}
                    type="number"
                    value={draft[key]}
                    onChange={(event) => {
                      setMessage(null);
                      setDraft((current) => ({ ...current, [key]: event.target.value }));
                    }}
                  />
                  <span className="w-5 text-xs font-semibold text-muted-foreground">ms</span>
                </label>
              }
            />
          );
        })}

        <div className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <p className="text-xs leading-5 text-muted-foreground">{t("settings.macroTimingNotice")}</p>
            {message ? (
              <p className="mt-1 text-xs font-semibold text-foreground" role="status">
                {message}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => {
                setDraft(createMacroSettingsDraft(DEFAULT_MACRO_SETTINGS));
                setMessage(null);
              }}
            >
              <RotateCcw size={14} />
              {t("settings.macroRestoreRecommended")}
            </Button>
            <Button
              type="button"
              disabled={isSaving || !isDirty || !parsed.settings}
              onClick={() => void save()}
            >
              <Save size={14} />
              {t("settings.macroSave")}
            </Button>
          </div>
        </div>
      </Surface>
    </section>
  );
}

function MacroSettingsRow({
  control,
  description,
  title
}: {
  control: ReactNode;
  description: ReactNode;
  title: string;
}): JSX.Element {
  return (
    <div className="settings-row glass-divider flex flex-col gap-3 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[13px] font-semibold leading-5 text-foreground">{title}</p>
        <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</div>
      </div>
      <div className="min-w-0 shrink-0 sm:w-auto">{control}</div>
    </div>
  );
}

function createMacroSettingsDraft(settings: MacroSettings): MacroSettingsDraft {
  return {
    startupDelayMs: String(settings.startupDelayMs),
    keyHoldMs: String(settings.keyHoldMs),
    postInputDelayMs: String(settings.postInputDelayMs),
    defaultLoopDelayMs: String(settings.defaultLoopDelayMs)
  };
}

function parseMacroSettingsDraft(draft: MacroSettingsDraft): {
  settings?: MacroSettings;
  values: MacroSettings;
} {
  const values: MacroSettings = {
    startupDelayMs: parseMacroSettingValue(draft.startupDelayMs),
    keyHoldMs: parseMacroSettingValue(draft.keyHoldMs),
    postInputDelayMs: parseMacroSettingValue(draft.postInputDelayMs),
    defaultLoopDelayMs: parseMacroSettingValue(draft.defaultLoopDelayMs)
  };
  const isValid = macroSettingItems.every(({ key }) => isValidMacroSettingValue(key, values[key]));
  return { values, ...(isValid ? { settings: values } : {}) };
}

function parseMacroSettingValue(value: string): number {
  return value.trim() ? Number(value) : Number.NaN;
}
