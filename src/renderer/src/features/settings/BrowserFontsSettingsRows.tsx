// Focused implementation extracted from SettingsRoute.tsx.
import { Check, ChevronDown, CloudDownload, Loader2, RotateCcw, Trash2, TriangleAlert } from "lucide-react";

import { type JSX, useEffect, useState } from "react";

import { Button } from "../../components/ui/button";

import { Input } from "../../components/ui/input";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";

import { SettingsRow, StatusCallout, Surface } from "../../components/ui/patterns";

import { type Language, type TranslationKey, type Translator } from "../../i18n";

import { DEFAULT_BROWSER_FONT_SETTINGS, browserFontPresets, browserFontSlots, normalizeBrowserFontFamily, normalizeGameBrowserSettings, resolveBrowserFontPreset, type BrowserFontPresetId } from "../../../../shared/browserFonts";

import type { BrowserFontCatalogEntry, BrowserFontCjkVariant, BrowserFontSelection, BrowserFontSlot, GameBrowserSettings, SystemFontFamily } from "../../../../shared/types";

import { decodeBrowserFontBase64, formatBrowserFontBytes, formatBrowserFontSettingsSummary, getBrowserSystemFontOptions, getSelectedBrowserGoogleFonts, resolveEffectiveBrowserFontCjkVariant } from "./MacroBadgePositionSettingsRows";

import { BrowserFontPresetCards, BrowserFontSelectionPicker, BrowserFontsPreview } from "./BrowserFontWidgets";

import { browserFontSlotDescriptionKeys, browserFontSlotLabelKeys } from "./settingsPresentation";

interface BrowserFontsSettingsRowsProps {
  language: Language;
  settings: GameBrowserSettings;
  systemFonts: SystemFontFamily[];
  t: Translator;
  onError: (error: unknown) => void;
  onLoadSystemFonts: () => Promise<SystemFontFamily[]>;
  onSave: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>;
}

export function BrowserFontsSettingsRows({
  language,
  settings,
  systemFonts,
  t,
  onError,
  onLoadSystemFonts,
  onSave
}: BrowserFontsSettingsRowsProps): JSX.Element {
  const [draft, setDraft] = useState<GameBrowserSettings>(() => normalizeGameBrowserSettings(settings));
  const [savedSettings, setSavedSettings] = useState<GameBrowserSettings>(() =>
    normalizeGameBrowserSettings(settings)
  );
  const [availableFonts, setAvailableFonts] = useState<SystemFontFamily[]>(systemFonts);
  const [catalog, setCatalog] = useState<BrowserFontCatalogEntry[]>([]);
  const [isLoadingFonts, setIsLoadingFonts] = useState(systemFonts.length === 0);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isAdvancedExpanded, setIsAdvancedExpanded] = useState(false);
  const [busyCatalogId, setBusyCatalogId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<string | null>(null);
  const [customFontFamily, setCustomFontFamily] = useState("");
  const [customFontNotice, setCustomFontNotice] = useState<{
    tone: "success" | "destructive";
    text: string;
  } | null>(null);
  const [isInstallingCustomFont, setIsInstallingCustomFont] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [previewFamilies, setPreviewFamilies] = useState<Record<string, string>>({});
  const fontOptions = getBrowserSystemFontOptions(availableFonts, draft);
  const isDirty = JSON.stringify(normalizeGameBrowserSettings(draft)) !== JSON.stringify(savedSettings);
  const selectedGoogleFonts = getSelectedBrowserGoogleFonts(draft);
  const selectedCatalogIds = selectedGoogleFonts.map((selection) => selection.catalogId);
  const installedCatalogIds = new Set(catalog.filter((font) => font.installed).map((font) => font.catalogId));
  const missingGoogleFonts = selectedGoogleFonts.filter(
    (selection) => !installedCatalogIds.has(selection.catalogId)
  );
  const installedFonts = catalog.filter((font) => font.installed);
  const normalizedCustomFontFamily = normalizeBrowserFontFamily(customFontFamily);
  const savedCjkVariant = savedSettings.fonts.cjkVariant;
  const effectiveCjkVariant = resolveEffectiveBrowserFontCjkVariant(draft.fonts.cjkVariant, language);
  const savedEffectiveCjkVariant = resolveEffectiveBrowserFontCjkVariant(savedCjkVariant, language);
  const previewKey = `${JSON.stringify(draft.fonts)}:${catalog
    .filter((font) => font.installed)
    .map((font) => `${font.catalogId}:${font.cachedBytes}`)
    .join("|")}`;

  useEffect(() => {
    const normalized = normalizeGameBrowserSettings(settings);
    setSavedSettings(normalized);
    setDraft(normalized);
  }, [settings]);

  useEffect(() => {
    setAvailableFonts(systemFonts);
    if (systemFonts.length > 0) {
      setIsLoadingFonts(false);
    }
  }, [systemFonts]);

  useEffect(() => {
    if (systemFonts.length > 0) {
      return;
    }

    let isDisposed = false;
    setIsLoadingFonts(true);

    void onLoadSystemFonts()
      .then((fonts) => {
        if (!isDisposed) {
          setAvailableFonts(fonts);
        }
      })
      .catch(onError)
      .finally(() => {
        if (!isDisposed) {
          setIsLoadingFonts(false);
        }
      });

    return () => {
      isDisposed = true;
    };
  }, [onError, onLoadSystemFonts, systemFonts.length]);

  useEffect(() => {
    let isDisposed = false;
    if (!window.rionStudio?.listBrowserFontCatalog) {
      setIsLoadingCatalog(false);
      return () => undefined;
    }
    setIsLoadingCatalog(true);
    void window.rionStudio
      .listBrowserFontCatalog()
      .then((fonts) => {
        if (!isDisposed) setCatalog(fonts);
      })
      .catch(onError)
      .finally(() => {
        if (!isDisposed) setIsLoadingCatalog(false);
      });
    return () => {
      isDisposed = true;
    };
  }, [onError]);

  useEffect(() => {
    let isDisposed = false;
    const loadedFaces: FontFace[] = [];
    setPreviewFamilies({});
    if (
      !isExpanded ||
      draft.fonts.mode !== "custom" ||
      selectedCatalogIds.length === 0 ||
      !window.rionStudio?.getBrowserFontPreview
    ) {
      return () => undefined;
    }

    void window.rionStudio
      .getBrowserFontPreview(draft.fonts)
      .then(async (payload) => {
        const families: Record<string, string> = {};
        const pendingFaces = payload.faces.map(async (asset) => {
          const alias = `Rion Settings Preview ${asset.catalogId}`;
          try {
            const bytes = decodeBrowserFontBase64(asset.dataBase64);
            const face = new FontFace(alias, bytes.buffer, {
              style: asset.style,
              unicodeRange: asset.unicodeRange || "U+0-10FFFF",
              weight: asset.weight
            });
            await face.load();
            return { alias, catalogId: asset.catalogId, face };
          } catch {
            // A failed preview face does not prevent saving or using the verified game cache.
            return undefined;
          }
        });
        const resolvedFaces = await Promise.all(pendingFaces);
        if (isDisposed) return;
        for (const loaded of resolvedFaces) {
          if (!loaded) continue;
          try {
            const { alias, catalogId, face } = loaded;
            document.fonts.add(face);
            loadedFaces.push(face);
            families[catalogId] = alias;
          } catch {
            // A failed preview face does not prevent saving or using the verified game cache.
          }
        }
        if (!isDisposed) setPreviewFamilies(families);
      })
      .catch((error) => {
        if (!isDisposed) onError(error);
      });

    return () => {
      isDisposed = true;
      for (const face of loadedFaces) document.fonts.delete(face);
    };
  }, [draft.fonts, isExpanded, onError, previewKey, selectedCatalogIds.length]);

  function handleFontSelectionChange(slot: BrowserFontSlot, selection: BrowserFontSelection | undefined): void {
    setMessage(null);
    setDraft((current) => {
      const slots = { ...current.fonts.slots };
      if (selection) slots[slot] = selection;
      else delete slots[slot];
      return normalizeGameBrowserSettings({
        ...current,
        fonts: {
          cjkVariant: current.fonts.cjkVariant,
          fontSmoothingEnabled: current.fonts.fontSmoothingEnabled,
          mode: "custom",
          slots
        }
      });
    });
  }

  function handlePresetChange(presetId: BrowserFontPresetId): void {
    setMessage(null);
    setDraft((current) => ({
      ...current,
      fonts: {
        ...resolveBrowserFontPreset(
          presetId,
          resolveEffectiveBrowserFontCjkVariant(current.fonts.cjkVariant, language)
        ),
        cjkVariant: current.fonts.cjkVariant,
        fontSmoothingEnabled: current.fonts.fontSmoothingEnabled
      }
    }));
  }

  function handleCjkVariantChange(cjkVariant: BrowserFontCjkVariant): void {
    const preset = browserFontPresets.find((candidate) => candidate.id === savedSettings.fonts.presetId);
    const fonts = preset
      ? {
          ...resolveBrowserFontPreset(
            preset.id,
            resolveEffectiveBrowserFontCjkVariant(cjkVariant, language)
          ),
          cjkVariant,
          fontSmoothingEnabled: savedSettings.fonts.fontSmoothingEnabled
        }
      : { ...savedSettings.fonts, cjkVariant };
    void saveSettings({ ...savedSettings, fonts });
  }

  async function reloadCatalog(): Promise<BrowserFontCatalogEntry[]> {
    const fonts = await window.rionStudio.listBrowserFontCatalog();
    setCatalog(fonts);
    return fonts;
  }

  async function removeCatalogFont(catalogId: string): Promise<void> {
    setBusyCatalogId(catalogId);
    try {
      await window.rionStudio.removeBrowserFont(catalogId);
      await reloadCatalog();
    } catch (error) {
      onError(error);
    } finally {
      setBusyCatalogId(null);
    }
  }

  async function installCustomGoogleFont(): Promise<void> {
    const family = normalizeBrowserFontFamily(customFontFamily);
    if (!family) return;
    setIsInstallingCustomFont(true);
    setCustomFontNotice(null);
    try {
      await window.rionStudio.installGoogleFont(family);
      await reloadCatalog();
      setCustomFontFamily("");
      setCustomFontNotice({
        tone: "success",
        text: t("settings.browserFontsCustomDownloadSuccess").replace("{family}", family)
      });
    } catch (error) {
      setCustomFontNotice({
        tone: "destructive",
        text: t("settings.browserFontsCustomDownloadFailed").replace("{family}", family)
      });
      onError(error);
    } finally {
      setIsInstallingCustomFont(false);
    }
  }

  async function saveSettings(settingsToSave: GameBrowserSettings): Promise<void> {
    setIsSaving(true);
    setMessage(null);

    try {
      const normalized = normalizeGameBrowserSettings(settingsToSave);
      const requiredGoogleFonts = getSelectedBrowserGoogleFonts(normalized);
      const currentInstalledIds = new Set(
        catalog.filter((font) => font.installed).map((font) => font.catalogId)
      );
      const downloads = requiredGoogleFonts.filter(
        (selection) => !currentInstalledIds.has(selection.catalogId)
      );
      for (const [index, selection] of downloads.entries()) {
        const { catalogId } = selection;
        const font = catalog.find((candidate) => candidate.catalogId === catalogId);
        setBusyCatalogId(catalogId);
        setDownloadProgress(
          t("settings.browserFontsDownloading")
            .replace("{family}", font?.family ?? selection.family ?? catalogId)
            .replace("{current}", String(index + 1))
            .replace("{total}", String(downloads.length))
        );
        if (catalogId.startsWith("custom-") && selection.family) {
          await window.rionStudio.installGoogleFont(selection.family);
        } else {
          await window.rionStudio.installBrowserFont(catalogId);
        }
      }
      if (downloads.length > 0) await reloadCatalog();
      const persistedSettings = normalizeGameBrowserSettings(await onSave(settingsToSave));
      setSavedSettings(persistedSettings);
      setDraft(persistedSettings);
      setMessage(t("settings.browserFontsSaved"));
    } catch (error) {
      onError(error);
    } finally {
      setBusyCatalogId(null);
      setDownloadProgress(null);
      setIsSaving(false);
    }
  }

  return (
    <>
      <SettingsRow
        title={t("settings.browserFonts")}
        description={message ?? formatBrowserFontSettingsSummary(draft, t)}
        showDivider={!isExpanded}
        control={
          <Button
            type="button"
            variant="ghost"
            className="px-2.5"
            aria-label={t("settings.browserFontsCustomize")}
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded((current) => !current)}
          >
            <span>{t("settings.browserFontsCustomize")}</span>
            <ChevronDown
              size={14}
              className={isExpanded ? "rotate-180 transition-transform duration-150" : "transition-transform duration-150"}
            />
          </Button>
        }
      />

      {isExpanded ? (
        <div className="glass-divider border-b pb-3">
          <Surface className="mx-3 overflow-hidden" radius="lg" variant="strong">
            <div className="settings-row glass-divider grid gap-3 border-b px-4 py-4">
              <BrowserFontPresetCards
                activePresetId={draft.fonts.presetId}
                catalog={catalog}
                cjkVariant={effectiveCjkVariant}
                disabled={isSaving}
                previewEnabled={isExpanded}
                t={t}
                onSelect={handlePresetChange}
              />
            </div>

            {browserFontSlots.map((slot) => (
              <SettingsRow
                key={slot}
                title={t(browserFontSlotLabelKeys[slot])}
                description={t(browserFontSlotDescriptionKeys[slot])}
                control={
                  <BrowserFontSelectionPicker
                    catalog={catalog}
                    cjkVariant={effectiveCjkVariant}
                    disabled={isSaving || isInstallingCustomFont}
                    label={t(browserFontSlotLabelKeys[slot])}
                    previewEnabled={isExpanded}
                    selection={draft.fonts.slots[slot]}
                    slot={slot}
                    systemFonts={fontOptions}
                    t={t}
                    onChange={handleFontSelectionChange}
                  />
                }
              />
            ))}

            <div className="settings-row glass-divider grid gap-3 border-b px-4 py-4">
              <BrowserFontsPreview
                catalog={catalog}
                cjkVariant={effectiveCjkVariant}
                previewFamilies={previewFamilies}
                previewEnabled={isExpanded}
                settings={draft}
                t={t}
              />
              <StatusCallout className="leading-5" tone="warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{t("settings.browserFontsForceWarning")}</span>
              </StatusCallout>
            </div>

            <div className="settings-row flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-control text-muted-foreground" role="status">
                {downloadProgress ??
                  (isLoadingFonts || isLoadingCatalog
                    ? t("settings.browserFontsLoading")
                    : isDirty
                      ? t("settings.browserFontsUnsaved")
                      : t("settings.browserFontsOnlinePreviewDescription"))}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={isSaving || isInstallingCustomFont || !isDirty}
                  onClick={() => {
                    setDraft(savedSettings);
                    setMessage(null);
                  }}
                >
                  {t("settings.browserFontsCancel")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSaving || isInstallingCustomFont}
                  onClick={() => {
                    setMessage(null);
                    setDraft((current) =>
                      normalizeGameBrowserSettings({
                        ...current,
                        fonts: {
                          ...DEFAULT_BROWSER_FONT_SETTINGS,
                          fontSmoothingEnabled: current.fonts.fontSmoothingEnabled
                        }
                      })
                    );
                  }}
                >
                  <RotateCcw size={14} />
                  {t("settings.browserFontsReset")}
                </Button>
                <Button
                  type="button"
                  disabled={
                    isSaving ||
                    isInstallingCustomFont ||
                    busyCatalogId !== null ||
                    (!isDirty && missingGoogleFonts.length === 0)
                  }
                  onClick={() => void saveSettings(draft)}
                >
                  {missingGoogleFonts.length > 0 ? <CloudDownload size={14} /> : null}
                  {missingGoogleFonts.length > 0
                    ? t("settings.browserFontsDownloadApply").replace("{count}", String(missingGoogleFonts.length))
                    : t("settings.browserFontsApply")}
                </Button>
              </div>
            </div>
          </Surface>
        </div>
      ) : null}

      <SettingsRow
        title={t("settings.browserFontsCjkVariant")}
        description={t("settings.browserFontsCjkResolved").replace(
          "{variant}",
          t(`settings.browserFonts.cjk.${savedEffectiveCjkVariant}` as TranslationKey)
        )}
        control={
          <Select
            disabled={isSaving || isInstallingCustomFont}
            value={savedCjkVariant}
            onValueChange={(value) => handleCjkVariantChange(value as BrowserFontCjkVariant)}
          >
            <SelectTrigger
              className="settings-menu-control"
              aria-label={t("settings.browserFontsCjkVariant")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["auto", "tc", "sc", "jp"] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`settings.browserFonts.cjk.${value}` as TranslationKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <SettingsRow
        title={t("settings.browserFontsAdvanced")}
        description={t("settings.browserFontsAdvancedDescription")}
        showDivider={!isAdvancedExpanded}
        control={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("settings.browserFontsAdvanced")}
            aria-expanded={isAdvancedExpanded}
            onClick={() => setIsAdvancedExpanded((current) => !current)}
          >
            <ChevronDown
              size={14}
              className={isAdvancedExpanded ? "rotate-180 transition-transform duration-150" : "transition-transform duration-150"}
            />
          </Button>
        }
      />

      {isAdvancedExpanded ? (
        <div className="glass-divider border-b pb-3">
          <Surface className="mx-3 overflow-hidden" radius="lg" variant="strong">
            <div className="grid w-full gap-4 px-4 py-4">
              <div className="grid gap-2.5">
                <div className="min-w-0">
                  <p className="text-xs font-semibold leading-5 text-foreground">
                    {t("settings.browserFontsCustomDownloadTitle")}
                  </p>
                  <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
                    {t("settings.browserFontsCustomDownloadDescription")}
                  </p>
                </div>
                <form
                  className="flex flex-col gap-2 sm:flex-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void installCustomGoogleFont();
                  }}
                >
                  <Input
                    aria-label={t("settings.browserFontsCustomDownloadLabel")}
                    autoComplete="off"
                    className="min-w-0 flex-1"
                    disabled={isSaving || isInstallingCustomFont}
                    maxLength={120}
                    placeholder={t("settings.browserFontsCustomDownloadPlaceholder")}
                    value={customFontFamily}
                    onChange={(event) => {
                      setCustomFontFamily(event.target.value);
                      setCustomFontNotice(null);
                    }}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={isSaving || isInstallingCustomFont || !normalizedCustomFontFamily}
                  >
                    {isInstallingCustomFont ? <Loader2 className="animate-spin" size={14} /> : <CloudDownload size={14} />}
                    {isInstallingCustomFont
                      ? t("settings.browserFontsCustomDownloading")
                      : t("settings.browserFontsCustomDownloadAction")}
                  </Button>
                </form>
                {customFontNotice ? (
                  <StatusCallout
                    aria-live={customFontNotice.tone === "success" ? "polite" : undefined}
                    role={customFontNotice.tone === "destructive" ? "alert" : "status"}
                    tone={customFontNotice.tone}
                  >
                    {customFontNotice.tone === "destructive" ? (
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <span>{customFontNotice.text}</span>
                  </StatusCallout>
                ) : null}
              </div>

              <div className="grid gap-2.5">
                <div>
                  <p className="text-xs font-semibold leading-5 text-foreground">
                    {t("settings.browserFontsCache")} · {formatBrowserFontBytes(
                      installedFonts.reduce((total, font) => total + font.cachedBytes, 0)
                    )}
                  </p>
                  <p className="mt-0.5 text-caption text-muted-foreground">
                    {t("settings.browserFontsCacheDescription")}
                  </p>
                </div>
                {installedFonts.length === 0 ? (
                  <p className="rounded-md bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
                    {t("settings.browserFontsCacheEmpty")}
                  </p>
                ) : (
                  <div className="browser-font-cache-grid grid gap-2">
                    {installedFonts.map((font) => {
                      const isSelected = selectedCatalogIds.includes(font.catalogId);
                      return (
                        <div key={font.catalogId} className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-muted/20 px-2.5 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-foreground">{font.family}</p>
                            <p className="text-micro text-muted-foreground">{formatBrowserFontBytes(font.cachedBytes)}</p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={t("settings.browserFontsRemove")}
                            disabled={isSaving || isInstallingCustomFont || busyCatalogId === font.catalogId || isSelected}
                            title={isSelected ? t("settings.browserFontsInUse") : t("settings.browserFontsRemove")}
                            onClick={() => void removeCatalogFont(font.catalogId)}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <p className="text-caption leading-5 text-muted-foreground">
                {t("settings.browserFontsGoogleNotice")}
              </p>
            </div>
          </Surface>
        </div>
      ) : null}
    </>
  );
}
