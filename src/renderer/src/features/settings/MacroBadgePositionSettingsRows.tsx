// Focused implementation extracted from SettingsRoute.tsx.
import { type JSX, useEffect, useRef, useState } from "react";

import { Slider } from "../../components/ui/slider";

import { SegmentedControl, SettingsRow } from "../../components/ui/patterns";

import { type Language, type Translator } from "../../i18n";

import { browserFontPresets, browserFontSlots, normalizeGameBrowserSettings } from "../../../../shared/browserFonts";

import { macroBadgeHorizontalMarginsPx, macroBadgeTopPositionsPx } from "../../../../shared/macroOverlay";

import type { BrowserFontCatalogEntry, BrowserFontCjkVariant, BrowserFontSelection, GameBrowserSettings, GameBrowserSettingsPatch, MacroBadgeHorizontalAlign, MacroBadgePositionSettings, PortableImportPreview, SystemFontFamily } from "../../../../shared/types";

import { type PortableDataAvailability } from "./portableSelection";

import { browserFontPresetLabelKeys } from "./settingsPresentation";

import type { PortableDataCounts } from "./SettingsRoute";

interface MacroBadgePositionSettingsRowsProps {
  settings: GameBrowserSettings;
  t: Translator;
  onError: (error: unknown) => void;
  onSave: (patch: GameBrowserSettingsPatch) => Promise<GameBrowserSettings>;
}

export function MacroBadgePositionSettingsRows({
  settings,
  t,
  onError,
  onSave
}: MacroBadgePositionSettingsRowsProps): JSX.Element {
  const normalizedSettings = normalizeGameBrowserSettings(settings);
  const [draft, setDraft] = useState<MacroBadgePositionSettings>(normalizedSettings.macroBadgePosition);
  const draftRef = useRef(draft);
  const settingsRef = useRef(settings);
  const pendingRef = useRef<MacroBadgePositionSettings | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlightRef = useRef(false);

  settingsRef.current = settings;
  draftRef.current = draft;

  useEffect(() => {
    if (pendingRef.current || saveInFlightRef.current) {
      return;
    }

    const nextDraft = normalizeGameBrowserSettings(settings).macroBadgePosition;
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }, [settings]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    },
    []
  );

  function scheduleSave(): void {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    // event-topology: coalesce
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, 250);
  }

  async function flushSave(): Promise<void> {
    if (saveInFlightRef.current) {
      return;
    }

    const nextPosition = pendingRef.current;
    if (!nextPosition) {
      return;
    }

    pendingRef.current = null;
    saveInFlightRef.current = true;

    try {
      const savedSettings = await onSave({ macroBadgePosition: nextPosition });
      settingsRef.current = savedSettings;
      if (!pendingRef.current) {
        draftRef.current = savedSettings.macroBadgePosition;
        setDraft(savedSettings.macroBadgePosition);
      }
    } catch (error) {
      if (!pendingRef.current) {
        const persistedPosition = normalizeGameBrowserSettings(settingsRef.current).macroBadgePosition;
        draftRef.current = persistedPosition;
        setDraft(persistedPosition);
      }
      onError(error);
    } finally {
      saveInFlightRef.current = false;
      if (pendingRef.current) {
        scheduleSave();
      }
    }
  }

  function updateDraft(update: Partial<MacroBadgePositionSettings>): void {
    const nextDraft = {
      ...draftRef.current,
      ...update
    };
    draftRef.current = nextDraft;
    pendingRef.current = nextDraft;
    setDraft(nextDraft);
    scheduleSave();
  }

  const topMin = macroBadgeTopPositionsPx[0] ?? 0;
  const topMax = macroBadgeTopPositionsPx[macroBadgeTopPositionsPx.length - 1] ?? 320;
  const horizontalMarginMin = macroBadgeHorizontalMarginsPx[0] ?? 0;
  const horizontalMarginMax =
    macroBadgeHorizontalMarginsPx[macroBadgeHorizontalMarginsPx.length - 1] ?? 128;

  return (
    <>
      <SettingsRow
        title={t("settings.macroBadgeHorizontalAlign")}
        description={t("settings.macroBadgeHorizontalAlignDescription")}
        control={
          <SegmentedControl<MacroBadgeHorizontalAlign>
            className="settings-menu-control settings-segmented-menu grid-cols-3"
            items={[
              { value: "left", label: t("settings.macroBadgeHorizontalAlignLeft") },
              { value: "center", label: t("settings.macroBadgeHorizontalAlignCenter") },
              { value: "right", label: t("settings.macroBadgeHorizontalAlignRight") }
            ]}
            value={draft.horizontalAlign}
            onValueChange={(horizontalAlign) => updateDraft({ horizontalAlign })}
          />
        }
      />
      <SettingsRow
        title={t("settings.macroBadgeTop")}
        description={t("settings.macroBadgeTopDescription")}
        control={
          <div className="grid w-full min-w-[240px] gap-1.5 sm:w-[320px]">
            <div className="flex items-center gap-3">
              <Slider
                aria-label={t("settings.macroBadgeTop")}
                max={topMax}
                min={topMin}
                step={8}
                value={[draft.topPx]}
                onValueChange={([topPx]) => {
                  if (typeof topPx === "number") {
                    updateDraft({ topPx });
                  }
                }}
              />
              <output className="w-14 shrink-0 text-right text-xs font-semibold text-muted-foreground">
                {draft.topPx} px
              </output>
            </div>
          </div>
        }
      />
      <SettingsRow
        showDivider={false}
        title={t("settings.macroBadgeHorizontalMargin")}
        description={t("settings.macroBadgeHorizontalMarginDescription")}
        control={
          <div className="grid w-full min-w-[240px] gap-1.5 sm:w-[320px]">
            <div className="flex items-center gap-3">
              <Slider
                aria-label={t("settings.macroBadgeHorizontalMargin")}
                max={horizontalMarginMax}
                min={horizontalMarginMin}
                step={8}
                value={[draft.horizontalMarginPx]}
                onValueChange={([horizontalMarginPx]) => {
                  if (typeof horizontalMarginPx === "number") {
                    updateDraft({ horizontalMarginPx });
                  }
                }}
              />
              <output className="w-14 shrink-0 text-right text-xs font-semibold text-muted-foreground">
                {draft.horizontalMarginPx} px
              </output>
            </div>
          </div>
        }
      />
    </>
  );
}

export function ReadOnlyValue({ value }: { value: string }): JSX.Element {
  return (
    <span className="glass-inset inline-flex h-[var(--control-height)] max-w-full items-center truncate rounded-sm px-2.5 text-control font-semibold leading-none text-foreground sm:max-w-[320px]">
      {value}
    </span>
  );
}

export function formatBrowserFontSettingsSummary(settings: GameBrowserSettings, t: Translator): string {
  if (settings.fonts.mode === "default") {
    return t("settings.browserFontsDefault");
  }

  const preset = browserFontPresets.find((candidate) => candidate.id === settings.fonts.presetId);
  if (preset) return t(browserFontPresetLabelKeys[preset.id]);
  const count = browserFontSlots.filter((slot) => settings.fonts.slots[slot]).length;
  return count > 0
    ? t("settings.browserFontsCustomSummary").replace("{count}", String(count))
    : t("settings.browserFontsCustomEmpty");
}

export function getBrowserSystemFontOptions(
  systemFonts: SystemFontFamily[],
  settings: GameBrowserSettings
): SystemFontFamily[] {
  const selectedFonts = browserFontSlots
    .map((slot) => settings.fonts.slots[slot])
    .filter((selection): selection is Extract<BrowserFontSelection, { source: "system" }> => selection?.source === "system")
    .map((selection) => selection.family);
  const fontsByKey = new Map<string, SystemFontFamily>();
  const genericFonts = ["system-ui", "ui-monospace", "math"].map((family) => ({ family, label: family }));

  for (const font of [...genericFonts, ...systemFonts, ...selectedFonts.map((family) => ({ family, label: family }))]) {
    const key = font.family.toLocaleLowerCase();
    if (!fontsByKey.has(key)) {
      fontsByKey.set(key, font);
    }
  }

  return [...fontsByKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function getSelectedBrowserGoogleFonts(
  settings: GameBrowserSettings
): Extract<BrowserFontSelection, { source: "google" }>[] {
  const selections = new Map<string, Extract<BrowserFontSelection, { source: "google" }>>();
  for (const slot of browserFontSlots) {
    const selection = settings.fonts.slots[slot];
    if (selection?.source === "google" && !selections.has(selection.catalogId)) {
      selections.set(selection.catalogId, selection);
    }
  }
  return [...selections.values()];
}

export function resolveEffectiveBrowserFontCjkVariant(
  variant: BrowserFontCjkVariant,
  language: Language
): Exclude<BrowserFontCjkVariant, "auto"> {
  if (variant !== "auto") return variant;
  if (language === "zh-CN") return "sc";
  if (language === "ja") return "jp";
  return "tc";
}

export function browserFontSelectionValue(selection?: BrowserFontSelection): string {
  if (!selection) return "fallback";
  return selection.source === "system"
    ? `system:${selection.family}`
    : `google:${selection.catalogId}`;
}

export function browserFontSelectionLabel(
  selection: BrowserFontSelection | undefined,
  systemFonts: SystemFontFamily[],
  catalog: BrowserFontCatalogEntry[],
  t: Translator
): string {
  if (!selection) return t("settings.browserFontsFallback");
  if (selection.source === "system") {
    const font = systemFonts.find((candidate) => candidate.family === selection.family);
    return `${font?.label ?? selection.family} · ${t("settings.browserFontsSourceSystem")}`;
  }

  const font = catalog.find((candidate) => candidate.catalogId === selection.catalogId);
  const status = font?.installed
    ? t("settings.browserFontsInstalled")
    : t("settings.browserFontsNotDownloaded");
  return `${font?.family ?? selection.family ?? selection.catalogId} · ${status}`;
}

export function parseBrowserFontSelectionValue(
  value: string,
  catalog: BrowserFontCatalogEntry[]
): BrowserFontSelection | undefined {
  if (value.startsWith("system:")) return { source: "system", family: value.slice(7) };
  if (value.startsWith("google:")) {
    const catalogId = value.slice(7);
    if (catalogId.startsWith("custom-")) {
      const family = catalog.find((candidate) => candidate.catalogId === catalogId)?.family;
      return family ? { source: "google", catalogId, family } : undefined;
    }
    return { source: "google", catalogId };
  }
  return undefined;
}

export function decodeBrowserFontBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function formatBrowserFontBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function createPortableExportAvailability(counts: PortableDataCounts): PortableDataAvailability {
  return {
    games: counts.gameCount > 0,
    roles: counts.roleCount > 0,
    launchWorkspaces: counts.workspaceCount > 0,
    gameWindows: counts.gameWindowCount > 0,
    macros: counts.macroCount > 0,
    preferences: true
  };
}

export function createPortableImportAvailability(preview: PortableImportPreview): PortableDataAvailability {
  return {
    games: preview.gameCount > 0,
    roles: preview.roleCount > 0,
    launchWorkspaces: preview.workspaceCount > 0,
    gameWindows: preview.gameWindowCount > 0,
    macros: preview.macroCount > 0,
    preferences: Boolean(preview.preferences)
  };
}
