import { ChevronDown, CloudDownload, Download, FileJson, FileText, Laptop, Moon, PenLine, RefreshCw, RotateCcw, Search, Sparkles, Sun, Trash2, Upload } from "lucide-react";
import { type JSX, type ReactNode, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { LegalDocumentDialog } from "../legal/LegalDocumentDialog";
import type { LegalDocumentKind } from "../legal/legalDocuments";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Slider } from "../../components/ui/slider";
import { Switch } from "../../components/ui/switch";
import { PageFrame, SegmentedControl, Surface } from "../../components/ui/patterns";
import {
  languageLabelKeys,
  resolvedThemeLabelKeys,
  themeLabelKeys,
  themeModes
} from "../../app/constants";
import type { ResolvedTheme, ThemeMode } from "../../app/types";
import { languages, type Language, type TranslationKey, type Translator } from "../../i18n";
import {
  DEFAULT_BROWSER_FONT_SETTINGS,
  browserFontPresets,
  browserFontSlots,
  normalizeGameBrowserSettings,
  resolveBrowserFontPreset,
  type BrowserFontPresetId,
  workspaceGapSizes
} from "../../../../shared/browserFonts";
import {
  macroBadgeHorizontalMarginsPx,
  macroBadgeTopPositionsPx
} from "../../../../shared/macroOverlay";
import { CURRENT_LEGAL_RELEASE, LEGAL_PROVIDER_NAME } from "../../../../shared/legal";
import type {
  AppUpdateStatus,
  BrowserFontCatalogEntry,
  BrowserFontCategory,
  BrowserFontCjkVariant,
  BrowserFontSelection,
  BrowserFontSlot,
  GameBrowserSettings,
  GameBrowserSettingsPatch,
  Game,
  MacroBadgeHorizontalAlign,
  MacroBadgePositionSettings,
  MacroSettings,
  PortableDataSelection,
  PortableExportInput,
  PortableExportResult,
  PortableImportInput,
  PortableImportOperations,
  PortableImportPreview,
  PortableImportResult,
  PortableImportWarning,
  PortableMacroConflictResolution,
  RuntimeWindowPreferences,
  Role,
  SystemFontFamily,
  WorkspaceAppearanceSettings,
  WorkspaceBackgroundStyle,
  WorkspaceGapSize
} from "../../../../shared/types";
import { MacroSettingsSection } from "./MacroSettingsSection";
import { DiagnosticsSettingsSection } from "./DiagnosticsSettingsSection";
import { ChromeProfileImportFlow } from "./ChromeProfileImportFlow";
import {
  clearPortableDataSelection,
  createDefaultPortableDataSelection,
  filterPortableImportWarnings,
  hasPortableDataSelection,
  isPortableGameSelectionRequired,
  isPortableRoleSelectionRequired,
  isPortableWorkspaceSelectionRequired,
  updatePortableDataSelection,
  type PortableDataAvailability,
  type PortableDataSection
} from "./portableSelection";
import { readSettingsSection, type SettingsSectionId } from "./settingsNavigation";

interface PortableDataCounts {
  gameCount: number;
  gameWindowCount: number;
  macroCount: number;
  roleCount: number;
  workspaceCount: number;
}

interface SettingsViewProps {
  games?: Game[];
  gameBrowserSettings: GameBrowserSettings;
  hasRunningRoles?: boolean;
  roles?: Role[];
  language: Language;
  macroSettings: MacroSettings;
  runtimeWindowPreferences: RuntimeWindowPreferences;
  portableDataCounts: PortableDataCounts;
  resolvedTheme: ResolvedTheme;
  t: Translator;
  themeMode: ThemeMode;
  updateStatus: AppUpdateStatus | null;
  updateVersion: string;
  isUpdateBusy: boolean;
  onCheckForUpdates: () => Promise<void>;
  onError: (error: unknown) => void;
  onExportPortableData: (input: PortableExportInput) => Promise<PortableExportResult | null>;
  onGameBrowserSettingsChange: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>;
  onGameBrowserSettingsPatch?: (patch: GameBrowserSettingsPatch) => Promise<GameBrowserSettings>;
  onMacroSettingsChange: (settings: MacroSettings) => Promise<MacroSettings>;
  onRuntimeWindowPreferencesChange: (
    preferences: RuntimeWindowPreferences
  ) => Promise<RuntimeWindowPreferences>;
  onLoadSystemFonts: () => Promise<SystemFontFamily[]>;
  onPreviewPortableImport: () => Promise<PortableImportPreview | null>;
  onApplyPortableImport: (input: PortableImportInput) => Promise<PortableImportResult>;
  onDiscardPortableImport: (importId: string) => Promise<void>;
  onOpenUpdateDownload: () => Promise<void>;
  onInstallDownloadedUpdate: () => Promise<void>;
  onSetAutoUpdateEnabled: (enabled: boolean) => Promise<void>;
  onLanguageChange: (language: Language) => void;
  onThemeModeChange: (themeMode: ThemeMode) => void;
  systemFonts: SystemFontFamily[];
}

interface SettingsViewBaseProps extends SettingsViewProps {
  activeSection: SettingsSectionId;
}

const settingsSectionTitleKeys: Record<SettingsSectionId, TranslationKey> = {
  aboutLegal: "settings.aboutLegal",
  data: "settings.data",
  interface: "settings.interface",
  macros: "settings.macros",
  updates: "settings.updates",
  diagnostics: "settings.diagnostics"
};

const settingsSectionDescriptionKeys: Record<SettingsSectionId, TranslationKey> = {
  aboutLegal: "settings.aboutLegalDescription",
  data: "settings.dataDescription",
  interface: "settings.interfaceDescription",
  macros: "settings.macrosDescription",
  updates: "settings.updatesDescription",
  diagnostics: "settings.diagnosticsDescription"
};

const browserFontSlotLabelKeys: Record<BrowserFontSlot, TranslationKey> = {
  cjk: "settings.browserFonts.slot.cjk",
  latin: "settings.browserFonts.slot.latin",
  numeric: "settings.browserFonts.slot.numeric",
  monospace: "settings.browserFonts.slot.monospace",
  math: "settings.browserFonts.slot.math"
};

const browserFontSlotDescriptionKeys: Record<BrowserFontSlot, TranslationKey> = {
  cjk: "settings.browserFonts.slot.cjkDescription",
  latin: "settings.browserFonts.slot.latinDescription",
  numeric: "settings.browserFonts.slot.numericDescription",
  monospace: "settings.browserFonts.slot.monospaceDescription",
  math: "settings.browserFonts.slot.mathDescription"
};

const browserFontPresetLabelKeys: Record<BrowserFontPresetId, TranslationKey> = {
  "system-default": "settings.browserFonts.preset.systemDefault",
  "modern-sans": "settings.browserFonts.preset.modernSans",
  "comfortable-reading": "settings.browserFonts.preset.comfortableReading",
  "clear-interface": "settings.browserFonts.preset.clearInterface",
  "clear-numbers": "settings.browserFonts.preset.clearNumbers",
  "code-monospace": "settings.browserFonts.preset.codeMonospace",
  "natural-handwriting": "settings.browserFonts.preset.naturalHandwriting",
  "playful-handwriting": "settings.browserFonts.preset.playfulHandwriting",
  "calligraphic-handwriting": "settings.browserFonts.preset.calligraphicHandwriting",
  "friendly-rounded": "settings.browserFonts.preset.friendlyRounded",
  "marker-notes": "settings.browserFonts.preset.markerNotes",
  "editorial-serif": "settings.browserFonts.preset.editorialSerif",
  "retro-game": "settings.browserFonts.preset.retroGame"
};

const browserFontPresetDescriptionKeys: Record<BrowserFontPresetId, TranslationKey> = {
  "system-default": "settings.browserFonts.preset.systemDefaultDescription",
  "modern-sans": "settings.browserFonts.preset.modernSansDescription",
  "comfortable-reading": "settings.browserFonts.preset.comfortableReadingDescription",
  "clear-interface": "settings.browserFonts.preset.clearInterfaceDescription",
  "clear-numbers": "settings.browserFonts.preset.clearNumbersDescription",
  "code-monospace": "settings.browserFonts.preset.codeMonospaceDescription",
  "natural-handwriting": "settings.browserFonts.preset.naturalHandwritingDescription",
  "playful-handwriting": "settings.browserFonts.preset.playfulHandwritingDescription",
  "calligraphic-handwriting": "settings.browserFonts.preset.calligraphicHandwritingDescription",
  "friendly-rounded": "settings.browserFonts.preset.friendlyRoundedDescription",
  "marker-notes": "settings.browserFonts.preset.markerNotesDescription",
  "editorial-serif": "settings.browserFonts.preset.editorialSerifDescription",
  "retro-game": "settings.browserFonts.preset.retroGameDescription"
};

function SettingsViewBase({
  activeSection,
  games = [],
  gameBrowserSettings,
  roles = [],
  language,
  macroSettings,
  runtimeWindowPreferences,
  portableDataCounts,
  resolvedTheme,
  t,
  themeMode,
  updateStatus,
  updateVersion,
  isUpdateBusy,
  onCheckForUpdates,
  onError,
  onExportPortableData,
  onGameBrowserSettingsChange,
  onGameBrowserSettingsPatch,
  onMacroSettingsChange,
  onRuntimeWindowPreferencesChange,
  onLoadSystemFonts,
  onPreviewPortableImport,
  onApplyPortableImport,
  onDiscardPortableImport,
  onOpenUpdateDownload,
  onInstallDownloadedUpdate,
  onSetAutoUpdateEnabled,
  onLanguageChange,
  onThemeModeChange,
  systemFonts
}: SettingsViewBaseProps): JSX.Element {
  const [isPortableExportOpen, setIsPortableExportOpen] = useState(false);
  const [portableExportSelection, setPortableExportSelection] = useState<PortableDataSelection>(
    clearPortableDataSelection
  );
  const [portableImportPreview, setPortableImportPreview] = useState<PortableImportPreview | null>(null);
  const [portableImportSelection, setPortableImportSelection] = useState<PortableDataSelection>(
    clearPortableDataSelection
  );
  const [portableImportResolutions, setPortableImportResolutions] = useState<PortableMacroConflictResolution[]>([]);
  const [portableMessage, setPortableMessage] = useState<string | null>(null);
  const [isPortableBusy, setIsPortableBusy] = useState(false);
  const [legalDocumentKind, setLegalDocumentKind] = useState<LegalDocumentKind | null>(null);
  const [isWorkspaceAppearanceSaving, setIsWorkspaceAppearanceSaving] = useState(false);
  const [isBrowserPerformanceSaving, setIsBrowserPerformanceSaving] = useState(false);
  const [isFontSmoothingSaving, setIsFontSmoothingSaving] = useState(false);
  const [isRuntimeWindowPreferencesSaving, setIsRuntimeWindowPreferencesSaving] =
    useState(false);
  const isMacOS = document.documentElement.dataset.platform === "mac";
  const canCheckForUpdates = Boolean(updateStatus?.isPackaged) && !isUpdateBusy;
  const isManualUpdate = updateStatus?.installMode === "manual";
  const canInstallUpdate = updateStatus?.state === "downloaded";
  const canOpenUpdateDownload =
    isManualUpdate &&
    updateStatus?.state === "available" &&
    Boolean(updateStatus.downloadUrl ?? updateStatus.releasePageUrl);
  const isAutoUpdateEnabled = updateStatus?.autoUpdateEnabled ?? true;
  const pageTitle = t(settingsSectionTitleKeys[activeSection]);
  const pageDescription = t(settingsSectionDescriptionKeys[activeSection]);
  const portableExportAvailability = createPortableExportAvailability(portableDataCounts);
  const saveNonFontPatch = onGameBrowserSettingsPatch ?? (async (patch: GameBrowserSettingsPatch) => {
    const normalizedSettings = normalizeGameBrowserSettings(gameBrowserSettings);
    return onGameBrowserSettingsChange({
      ...normalizedSettings,
      ...(patch.macroBadgePosition ? { macroBadgePosition: patch.macroBadgePosition } : {}),
      ...(patch.performance ? { performance: patch.performance } : {}),
      ...(patch.workspace ? { workspace: patch.workspace } : {})
    });
  });

  function updateWorkspaceAppearanceSettings(update: Partial<WorkspaceAppearanceSettings>): void {
    if (isWorkspaceAppearanceSaving) {
      return;
    }

    const normalizedSettings = normalizeGameBrowserSettings(gameBrowserSettings);
    setIsWorkspaceAppearanceSaving(true);
    void saveNonFontPatch({
      workspace: {
        ...normalizedSettings.workspace,
        ...update
      }
    })
      .catch(onError)
      .finally(() => setIsWorkspaceAppearanceSaving(false));
  }

  function updateBrowserPerformanceSettings(macosHighRefreshRate: boolean): void {
    if (isBrowserPerformanceSaving) {
      return;
    }

    const normalizedSettings = normalizeGameBrowserSettings(gameBrowserSettings);
    setIsBrowserPerformanceSaving(true);
    void saveNonFontPatch({
      performance: {
        ...normalizedSettings.performance,
        macosHighRefreshRate
      }
    })
      .catch(onError)
      .finally(() => setIsBrowserPerformanceSaving(false));
  }

  function updateFontSmoothingSetting(fontSmoothingEnabled: boolean): void {
    if (isFontSmoothingSaving) {
      return;
    }

    const normalizedSettings = normalizeGameBrowserSettings(gameBrowserSettings);
    setIsFontSmoothingSaving(true);
    void onGameBrowserSettingsChange({
      ...normalizedSettings,
      fonts: {
        ...normalizedSettings.fonts,
        fontSmoothingEnabled
      }
    })
      .catch(onError)
      .finally(() => setIsFontSmoothingSaving(false));
  }

  function handleOpenPortableExport(): void {
    setPortableExportSelection(createDefaultPortableDataSelection(portableExportAvailability));
    setPortableMessage(null);
    setIsPortableExportOpen(true);
  }

  async function handleExportPortableData(): Promise<void> {
    if (!hasPortableDataSelection(portableExportSelection)) {
      return;
    }

    setIsPortableBusy(true);
    setPortableMessage(null);

    try {
      const result = await onExportPortableData({
        preferences: {
          language,
          gameBrowserSettings,
          macroSettings,
          themeMode
        },
        selection: portableExportSelection
      });

      if (result) {
        setIsPortableExportOpen(false);
        setPortableMessage(formatPortableExportResult(result, t));
      }
    } catch (error) {
      onError(error);
    } finally {
      setIsPortableBusy(false);
    }
  }

  async function handlePreviewPortableImport(): Promise<void> {
    setIsPortableBusy(true);
    setPortableMessage(null);

    try {
      const preview = await onPreviewPortableImport();
      if (preview) {
        setPortableImportSelection(
          createDefaultPortableDataSelection(createPortableImportAvailability(preview))
        );
        setPortableImportResolutions([]);
        setPortableImportPreview(preview);
      }
    } catch (error) {
      onError(error);
    } finally {
      setIsPortableBusy(false);
    }
  }

  async function handleApplyPortableImport(): Promise<void> {
    if (!portableImportPreview) {
      return;
    }

    setIsPortableBusy(true);
    setPortableMessage(null);

    try {
      const result = await onApplyPortableImport({
        importId: portableImportPreview.importId,
        selection: portableImportSelection,
        resolutions: portableImportResolutions
      });
      setPortableImportPreview(null);
      setPortableMessage(formatPortableImportResult(result, t));
    } catch (error) {
      onError(error);
    } finally {
      setIsPortableBusy(false);
    }
  }

  async function handleCancelPortableImport(): Promise<void> {
    const preview = portableImportPreview;
    setPortableImportPreview(null);
    setPortableImportResolutions([]);
    if (!preview) {
      return;
    }
    try {
      await onDiscardPortableImport(preview.importId);
    } catch (error) {
      onError(error);
    }
  }

  return (
    <PageFrame
      maxWidth="settings"
      className="settings-page py-10 md:py-14"
      contentClassName="mx-auto flex min-h-full w-full max-w-[840px] flex-col gap-8"
    >
      <header className="settings-page-header">
        <h1 className="text-[26px] font-semibold leading-tight text-foreground">{pageTitle}</h1>
        <p className="mt-2 max-w-2xl text-[13px] leading-5 text-muted-foreground">{pageDescription}</p>
      </header>

      <div className="grid gap-8">
        {activeSection === "interface" ? (
          <>
            <SettingsSection>
              <SettingsRow
                title={t("settings.theme")}
                description={t("settings.themeDescription").replace("{theme}", t(resolvedThemeLabelKeys[resolvedTheme]))}
                control={
                  <SegmentedControl<ThemeMode>
                    className="settings-menu-control settings-segmented-menu grid-cols-3"
                    items={themeModes.map((mode) => ({
                      value: mode,
                      label: t(themeLabelKeys[mode]),
                      icon: mode === "system" ? Laptop : mode === "light" ? Sun : Moon
                    }))}
                    value={themeMode}
                    onValueChange={onThemeModeChange}
                  />
                }
              />
              <SettingsRow
                title={t("settings.language")}
                description={t("settings.languageDescription")}
                control={
                  <Select
                    value={language}
                    onValueChange={(value) => onLanguageChange(value as Language)}
                  >
                    <SelectTrigger className="settings-menu-control" aria-label={t("settings.language")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {languages.map((option) => (
                        <SelectItem key={option} value={option}>
                          {t(languageLabelKeys[option])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                }
              />
            </SettingsSection>

            <SettingsSection title={t("settings.game")}>
              <SettingsRow
                title={t("settings.browserFontSmoothing")}
                description={t("settings.browserFontSmoothingDescription")}
                control={
                  <Switch
                    aria-label={t("settings.browserFontSmoothing")}
                    checked={normalizeGameBrowserSettings(gameBrowserSettings).fonts.fontSmoothingEnabled}
                    disabled={isFontSmoothingSaving}
                    onCheckedChange={updateFontSmoothingSetting}
                  />
                }
              />
              <BrowserFontsSettingsRows
                language={language}
                settings={gameBrowserSettings}
                systemFonts={systemFonts}
                t={t}
                onError={onError}
                onLoadSystemFonts={onLoadSystemFonts}
                onSave={onGameBrowserSettingsChange}
              />
              {isMacOS ? (
                <SettingsRow
                  showDivider={false}
                  title={t("settings.macosHighRefreshRate")}
                  description={t("settings.macosHighRefreshRateDescription")}
                  control={
                    <Switch
                      aria-label={t("settings.macosHighRefreshRate")}
                      checked={normalizeGameBrowserSettings(gameBrowserSettings).performance.macosHighRefreshRate}
                      disabled={isBrowserPerformanceSaving}
                      onCheckedChange={updateBrowserPerformanceSettings}
                    />
                  }
                />
              ) : null}
            </SettingsSection>

            <SettingsSection title={t("settings.gameWindows")}>
              <SettingsRow
                title={t("settings.alwaysHideTabCloseButton")}
                description={t("settings.alwaysHideTabCloseButtonDescription")}
                control={
                  <Switch
                    aria-label={t("settings.alwaysHideTabCloseButton")}
                    checked={runtimeWindowPreferences.alwaysHideTabCloseButton}
                    disabled={isRuntimeWindowPreferencesSaving}
                    onCheckedChange={(alwaysHideTabCloseButton) => {
                      setIsRuntimeWindowPreferencesSaving(true);
                      void onRuntimeWindowPreferencesChange({
                        ...runtimeWindowPreferences,
                        alwaysHideTabCloseButton
                      })
                        .catch(onError)
                        .finally(() => setIsRuntimeWindowPreferencesSaving(false));
                    }}
                  />
                }
              />
              <SettingsRow
                showDivider={isMacOS}
                title={t("settings.restoreGameWindowsOnStartup")}
                description={t("settings.restoreGameWindowsOnStartupDescription")}
                control={
                  <Switch
                    aria-label={t("settings.restoreGameWindowsOnStartup")}
                    checked={runtimeWindowPreferences.restoreGameWindowsOnStartup}
                    disabled={isRuntimeWindowPreferencesSaving}
                    onCheckedChange={(restoreGameWindowsOnStartup) => {
                      setIsRuntimeWindowPreferencesSaving(true);
                      void onRuntimeWindowPreferencesChange({
                        ...runtimeWindowPreferences,
                        restoreGameWindowsOnStartup
                      })
                        .catch(onError)
                        .finally(() => setIsRuntimeWindowPreferencesSaving(false));
                    }}
                  />
                }
              />
            </SettingsSection>

            <SettingsSection title={t("settings.workspace")}>
              <SettingsRow
                title={t("settings.workspaceBackground")}
                description={t("settings.workspaceBackgroundDescription")}
                control={
                  <SegmentedControl<WorkspaceBackgroundStyle>
                    className="settings-menu-control settings-segmented-menu grid-cols-2"
                    disabled={isWorkspaceAppearanceSaving}
                    items={[
                      { value: "material", label: t("settings.workspaceBackgroundMaterial") },
                      { value: "black", label: t("settings.workspaceBackgroundBlack") }
                    ]}
                    value={normalizeGameBrowserSettings(gameBrowserSettings).workspace.background}
                    onValueChange={(background) => updateWorkspaceAppearanceSettings({ background })}
                  />
                }
              />
              <SettingsRow
                showDivider={false}
                title={t("settings.workspaceGap")}
                description={t("settings.workspaceGapDescription")}
                control={
                  <Select
                    disabled={isWorkspaceAppearanceSaving}
                    value={String(normalizeGameBrowserSettings(gameBrowserSettings).workspace.gap)}
                    onValueChange={(value) =>
                      updateWorkspaceAppearanceSettings({
                        gap: Number(value) as WorkspaceGapSize
                      })
                    }
                  >
                    <SelectTrigger
                      aria-label={t("settings.workspaceGapSize")}
                      className="settings-menu-control"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {workspaceGapSizes.map((size) => (
                        <SelectItem key={size} value={String(size)}>
                          {size} px
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                }
              />
            </SettingsSection>

            <SettingsSection title={t("settings.macroBadges")}>
              <MacroBadgePositionSettingsRows
                settings={gameBrowserSettings}
                t={t}
                onError={onError}
                onSave={saveNonFontPatch}
              />
            </SettingsSection>
          </>
        ) : null}

        {activeSection === "macros" ? (
          <MacroSettingsSection
            settings={macroSettings}
            t={t}
            onError={onError}
            onSave={onMacroSettingsChange}
          />
        ) : null}

        {activeSection === "data" ? (
          <SettingsSection>
            <SettingsRow
              title={t("settings.chromeImport")}
              description={t("settings.chromeImportEntryDescription")}
              control={<ChromeProfileImportFlow games={games} roles={roles} t={t} onError={onError} />}
            />
            <SettingsRow
              title={t("settings.portableExport")}
              description={t("settings.portableExportDescription")}
              control={
                <Button
                  type="button"
                  variant="outline"
                  disabled={isPortableBusy}
                  onClick={handleOpenPortableExport}
                >
                  <FileJson size={14} />
                  {t("settings.exportJson")}
                </Button>
              }
            />
            <SettingsRow
              title={t("settings.portableImport")}
              description={t("settings.portableImportDescription")}
              control={
                <Button
                  type="button"
                  disabled={isPortableBusy}
                  onClick={() => void handlePreviewPortableImport()}
                >
                  <Upload size={14} />
                  {t("settings.importJson")}
                </Button>
              }
            />
            {portableMessage ? (
              <div className="glass-divider border-b px-4 py-3 text-xs font-medium leading-5 text-muted-foreground last:border-b-0">
                {portableMessage}
              </div>
            ) : null}
          </SettingsSection>
        ) : null}

        {activeSection === "updates" ? (
          <SettingsSection>
            <SettingsRow
              title={t("settings.autoUpdate")}
              description={t(isAutoUpdateEnabled ? "settings.autoUpdateEnabled" : "settings.autoUpdateDisabled")}
              control={
                <Switch
                  aria-label={t("settings.autoUpdate")}
                  checked={isAutoUpdateEnabled}
                  disabled={!updateStatus?.isPackaged || isUpdateBusy}
                  onCheckedChange={(enabled) => {
                    void onSetAutoUpdateEnabled(enabled);
                  }}
                />
              }
            />
            <SettingsRow
              title={t("settings.currentVersion")}
              description={t("settings.currentVersionDescription")}
              control={<ReadOnlyValue value={updateVersion || updateStatus?.currentVersion || "0.0.0"} />}
            />
            <SettingsRow
              title={t("settings.updateStatus")}
              description={formatUpdateStatus(updateStatus, t)}
              control={
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!canCheckForUpdates}
                    onClick={() => void onCheckForUpdates()}
                  >
                    <RefreshCw size={14} className={isUpdateBusy ? "animate-spin" : undefined} />
                    {t("settings.checkUpdates")}
                  </Button>
                  <Button
                    type="button"
                    disabled={isManualUpdate ? !canOpenUpdateDownload : !canInstallUpdate}
                    onClick={() => void (isManualUpdate ? onOpenUpdateDownload() : onInstallDownloadedUpdate())}
                  >
                    {isManualUpdate ? <Download size={14} /> : <RotateCcw size={14} />}
                    {t(isManualUpdate ? "settings.downloadUpdate" : "settings.installUpdate")}
                  </Button>
                </div>
              }
            />
          </SettingsSection>
        ) : null}

        {activeSection === "diagnostics" ? <DiagnosticsSettingsSection roles={roles ?? []} t={t} onError={onError} /> : null}

        {activeSection === "aboutLegal" ? (
          <>
            <SettingsSection>
              <SettingsRow
                title={t("settings.legalProvider")}
                description={`${t("settings.legalProviderDescription")} ${t("settings.legalNoSupport")}`}
                control={<ReadOnlyValue value={LEGAL_PROVIDER_NAME} />}
              />
              <SettingsRow
                title={t("settings.currentVersion")}
                description={t("settings.currentVersionDescription")}
                control={<ReadOnlyValue value={updateVersion || updateStatus?.currentVersion || "0.0.0"} />}
              />
            </SettingsSection>

            <SettingsSection title={t("settings.legalDocuments")}>
              {(["terms", "privacy", "fairUse", "thirdParty"] as const).map((kind) => (
                <SettingsRow
                  key={kind}
                  title={t(`legal.document.${kind}`)}
                  description={t("legal.version").replace("{version}", CURRENT_LEGAL_RELEASE)}
                  control={
                    <Button type="button" variant="outline" onClick={() => setLegalDocumentKind(kind)}>
                      <FileText size={14} />
                      {t("settings.openLegalDocument")}
                    </Button>
                  }
                />
              ))}
            </SettingsSection>
          </>
        ) : null}
      </div>

      {isPortableExportOpen ? (
        <PortableExportDialog
          availability={portableExportAvailability}
          counts={portableDataCounts}
          isBusy={isPortableBusy}
          selection={portableExportSelection}
          t={t}
          onCancel={() => setIsPortableExportOpen(false)}
          onChange={setPortableExportSelection}
          onConfirm={() => void handleExportPortableData()}
        />
      ) : null}

      {portableImportPreview ? (
        <PortableImportDialog
          isBusy={isPortableBusy}
          preview={portableImportPreview}
          resolutions={portableImportResolutions}
          selection={portableImportSelection}
          t={t}
          onCancel={() => void handleCancelPortableImport()}
          onChange={setPortableImportSelection}
          onResolutionsChange={setPortableImportResolutions}
          onConfirm={() => void handleApplyPortableImport()}
        />
      ) : null}

      {legalDocumentKind ? (
        <LegalDocumentDialog
          kind={legalDocumentKind}
          language={language}
          t={t}
          onClose={() => setLegalDocumentKind(null)}
        />
      ) : null}

    </PageFrame>
  );
}

interface BrowserFontsSettingsRowsProps {
  language: Language;
  settings: GameBrowserSettings;
  systemFonts: SystemFontFamily[];
  t: Translator;
  onError: (error: unknown) => void;
  onLoadSystemFonts: () => Promise<SystemFontFamily[]>;
  onSave: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>;
}

function BrowserFontsSettingsRows({
  language,
  settings,
  systemFonts,
  t,
  onError,
  onLoadSystemFonts,
  onSave
}: BrowserFontsSettingsRowsProps): JSX.Element {
  const [draft, setDraft] = useState<GameBrowserSettings>(() => normalizeGameBrowserSettings(settings));
  const [availableFonts, setAvailableFonts] = useState<SystemFontFamily[]>(systemFonts);
  const [catalog, setCatalog] = useState<BrowserFontCatalogEntry[]>([]);
  const [category, setCategory] = useState<"all" | BrowserFontCategory>("all");
  const [fontSearch, setFontSearch] = useState("");
  const [isLoadingFonts, setIsLoadingFonts] = useState(systemFonts.length === 0);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [busyCatalogId, setBusyCatalogId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [previewFamilies, setPreviewFamilies] = useState<Record<string, string>>({});
  const fontOptions = getBrowserSystemFontOptions(availableFonts, draft);
  const isDirty = JSON.stringify(normalizeGameBrowserSettings(draft)) !== JSON.stringify(normalizeGameBrowserSettings(settings));
  const selectedCatalogIds = getSelectedBrowserFontCatalogIds(draft);
  const installedCatalogIds = new Set(catalog.filter((font) => font.installed).map((font) => font.catalogId));
  const missingCatalogIds = selectedCatalogIds.filter((catalogId) => !installedCatalogIds.has(catalogId));
  const installedFonts = catalog.filter((font) => font.installed);
  const effectiveCjkVariant = resolveEffectiveBrowserFontCjkVariant(draft.fonts.cjkVariant, language);
  const previewKey = `${JSON.stringify(draft.fonts)}:${catalog
    .filter((font) => font.installed)
    .map((font) => `${font.catalogId}:${font.cachedBytes}`)
    .join("|")}`;

  useEffect(() => {
    setDraft(normalizeGameBrowserSettings(settings));
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
  }, [draft.fonts, onError, previewKey, selectedCatalogIds.length]);

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
    setMessage(null);
    setDraft((current) => {
      const preset = browserFontPresets.find((candidate) => candidate.id === current.fonts.presetId);
      if (!preset) {
        return { ...current, fonts: { ...current.fonts, cjkVariant } };
      }
      return {
        ...current,
        fonts: {
          ...resolveBrowserFontPreset(
            preset.id,
            resolveEffectiveBrowserFontCjkVariant(cjkVariant, language)
          ),
          cjkVariant,
          fontSmoothingEnabled: current.fonts.fontSmoothingEnabled
        }
      };
    });
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

  async function saveSettings(settingsToSave: GameBrowserSettings): Promise<void> {
    setIsSaving(true);
    setMessage(null);

    try {
      const normalized = normalizeGameBrowserSettings(settingsToSave);
      const requiredCatalogIds = getSelectedBrowserFontCatalogIds(normalized);
      const currentInstalledIds = new Set(
        catalog.filter((font) => font.installed).map((font) => font.catalogId)
      );
      const downloads = requiredCatalogIds.filter((catalogId) => !currentInstalledIds.has(catalogId));
      for (const [index, catalogId] of downloads.entries()) {
        const font = catalog.find((candidate) => candidate.catalogId === catalogId);
        setBusyCatalogId(catalogId);
        setDownloadProgress(
          t("settings.browserFontsDownloading")
            .replace("{family}", font?.family ?? catalogId)
            .replace("{current}", String(index + 1))
            .replace("{total}", String(downloads.length))
        );
        await window.rionStudio.installBrowserFont(catalogId);
      }
      if (downloads.length > 0) await reloadCatalog();
      const savedSettings = await onSave(settingsToSave);
      setDraft(normalizeGameBrowserSettings(savedSettings));
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
            size="icon"
            aria-label={t("settings.browserFontsCustomize")}
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded((current) => !current)}
          >
            <ChevronDown
              size={16}
              className={isExpanded ? "rotate-180 transition-transform" : "transition-transform"}
            />
          </Button>
        }
      />

      {isExpanded ? (
        <div className="glass-divider border-b px-4 pb-4 pt-1">
          <div className="mb-4 h-px bg-border/35" />
          <div className="grid gap-5">
            <div className="rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs leading-5 text-muted-foreground">
              {t("settings.browserFontsForceWarning")}
            </div>

            <BrowserFontPresetCards
              activePresetId={draft.fonts.presetId}
              disabled={isSaving}
              t={t}
              onSelect={handlePresetChange}
            />

            <div className="grid gap-2">
              <p className="text-xs font-semibold leading-5 text-foreground">
                {t("settings.browserFontsCjkVariant")}
              </p>
              <SegmentedControl<BrowserFontCjkVariant>
                className="grid-cols-4"
                disabled={isSaving}
                items={(["auto", "tc", "sc", "jp"] as const).map((value) => ({
                  value,
                  label: t(`settings.browserFonts.cjk.${value}` as TranslationKey)
                }))}
                value={draft.fonts.cjkVariant}
                onValueChange={handleCjkVariantChange}
              />
              <p className="text-[11px] leading-4 text-muted-foreground">
                {t("settings.browserFontsCjkResolved").replace(
                  "{variant}",
                  t(`settings.browserFonts.cjk.${effectiveCjkVariant}` as TranslationKey)
                )}
              </p>
            </div>

            <div className="grid gap-2">
              <div className="flex flex-col gap-2 sm:flex-row">
                <label className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    disabled={isSaving}
                    placeholder={t("settings.browserFontsSearchPlaceholder")}
                    value={fontSearch}
                    onChange={(event) => setFontSearch(event.target.value)}
                  />
                </label>
                <Select
                  disabled={isSaving}
                  value={category}
                  onValueChange={(value) => setCategory(value as "all" | BrowserFontCategory)}
                >
                  <SelectTrigger className="w-full sm:w-44" aria-label={t("settings.browserFontsCategory")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["all", "sans", "serif", "handwriting", "display", "monospace", "math"] as const).map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {t(`settings.browserFonts.category.${value}` as TranslationKey)}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {browserFontSlots.map((slot) => (
                  <BrowserFontSelectionPicker
                    key={slot}
                    catalog={catalog}
                    category={category}
                    cjkVariant={effectiveCjkVariant}
                    disabled={isSaving}
                    label={t(browserFontSlotLabelKeys[slot])}
                    description={t(browserFontSlotDescriptionKeys[slot])}
                    search={fontSearch}
                    selection={draft.fonts.slots[slot]}
                    slot={slot}
                    systemFonts={fontOptions}
                    t={t}
                    onChange={handleFontSelectionChange}
                  />
                ))}
              </div>
            </div>

            <BrowserFontsPreview
              previewFamilies={previewFamilies}
              settings={draft}
              t={t}
            />

            {isLoadingFonts || isLoadingCatalog ? (
              <p className="text-xs leading-5 text-muted-foreground">{t("settings.browserFontsLoading")}</p>
            ) : null}

            <p className="text-[11px] leading-4 text-muted-foreground">
              {t("settings.browserFontsGoogleNotice")}
            </p>

            <details className="rounded-md border border-border/25 px-3 py-2">
              <summary className="cursor-pointer select-none text-xs font-semibold leading-5 text-foreground">
                {t("settings.browserFontsCache")} · {formatBrowserFontBytes(
                  installedFonts.reduce((total, font) => total + font.cachedBytes, 0)
                )}
              </summary>
              <div className="mt-2 grid gap-2">
                <p className="text-[11px] leading-4 text-muted-foreground">
                  {t("settings.browserFontsCacheDescription")}
                </p>
                {installedFonts.length === 0 ? (
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("settings.browserFontsCacheEmpty")}
                  </p>
                ) : (
                  installedFonts.map((font) => {
                    const isSelected = selectedCatalogIds.includes(font.catalogId);
                    return (
                      <div key={font.catalogId} className="flex items-center justify-between gap-3 rounded-md bg-muted/20 px-2.5 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold text-foreground">{font.family}</p>
                          <p className="text-[10px] text-muted-foreground">{formatBrowserFontBytes(font.cachedBytes)}</p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t("settings.browserFontsRemove")}
                          disabled={isSaving || busyCatalogId === font.catalogId || isSelected}
                          title={isSelected ? t("settings.browserFontsInUse") : t("settings.browserFontsRemove")}
                          onClick={() => void removeCatalogFont(font.catalogId)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    );
                  })
                )}
              </div>
            </details>

            {downloadProgress ? (
              <p className="text-xs font-medium leading-5 text-primary">{downloadProgress}</p>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={isSaving}
                onClick={() =>
                  void saveSettings(
                    normalizeGameBrowserSettings({
                      ...draft,
                      fonts: {
                        ...DEFAULT_BROWSER_FONT_SETTINGS,
                        fontSmoothingEnabled: draft.fonts.fontSmoothingEnabled
                      }
                    })
                  )
                }
              >
                <RotateCcw size={14} />
                {t("settings.browserFontsReset")}
              </Button>
              <Button
                type="button"
                disabled={isSaving || busyCatalogId !== null || (!isDirty && missingCatalogIds.length === 0)}
                onClick={() => void saveSettings(draft)}
              >
                {missingCatalogIds.length > 0 ? <CloudDownload size={14} /> : null}
                {missingCatalogIds.length > 0
                  ? t("settings.browserFontsDownloadApply").replace("{count}", String(missingCatalogIds.length))
                  : t("settings.browserFontsApply")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

interface BrowserFontPresetCardsProps {
  activePresetId?: string;
  disabled: boolean;
  t: Translator;
  onSelect: (presetId: BrowserFontPresetId) => void;
}

function BrowserFontPresetCards({
  activePresetId,
  disabled,
  t,
  onSelect
}: BrowserFontPresetCardsProps): JSX.Element {
  return (
    <div className="grid gap-3">
      {(["general", "handwriting", "personality"] as const).map((category) => (
        <div key={category} className="grid gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold leading-5 text-foreground">
            {category === "handwriting" ? <PenLine size={14} /> : null}
            {category === "personality" ? <Sparkles size={14} /> : null}
            {t(
              category === "general"
                ? "settings.browserFontsPresetsGeneral"
                : category === "handwriting"
                  ? "settings.browserFontsPresetsHandwriting"
                  : "settings.browserFontsPresetsPersonality"
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {browserFontPresets
              .filter((preset) => preset.category === category)
              .map((preset) => {
                const isActive = activePresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={isActive}
                    disabled={disabled}
                    className={`min-h-[74px] rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-45 ${
                      isActive
                        ? "border-primary/45 bg-primary/[0.08] text-foreground"
                        : "border-border/30 bg-muted/10 text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                    }`}
                    onClick={() => onSelect(preset.id)}
                  >
                    <span className="block text-xs font-semibold leading-5">
                      {t(browserFontPresetLabelKeys[preset.id])}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-4">
                      {t(browserFontPresetDescriptionKeys[preset.id])}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}

interface BrowserFontSelectionPickerProps {
  catalog: BrowserFontCatalogEntry[];
  category: "all" | BrowserFontCategory;
  cjkVariant: Exclude<BrowserFontCjkVariant, "auto">;
  disabled: boolean;
  label: string;
  description: string;
  search: string;
  selection?: BrowserFontSelection;
  slot: BrowserFontSlot;
  systemFonts: SystemFontFamily[];
  t: Translator;
  onChange: (slot: BrowserFontSlot, selection: BrowserFontSelection | undefined) => void;
}

function BrowserFontSelectionPicker({
  catalog,
  category,
  cjkVariant,
  disabled,
  label,
  description,
  search,
  selection,
  slot,
  systemFonts,
  t,
  onChange
}: BrowserFontSelectionPickerProps): JSX.Element {
  const query = search.trim().toLocaleLowerCase();
  const selectedCatalogId = selection?.source === "google" ? selection.catalogId : undefined;
  const selectedSystemFamily = selection?.source === "system" ? selection.family : undefined;
  const filteredSystemFonts = systemFonts.filter(
    (font) => !query || font.family.toLocaleLowerCase().includes(query) || font.label.toLocaleLowerCase().includes(query)
  );
  const filteredCatalog = catalog.filter((font) => {
    const matchesSearch = !query || font.family.toLocaleLowerCase().includes(query);
    const matchesCategory = category === "all" || font.category === category;
    const matchesScript = slot !== "cjk" || font.scripts.includes(cjkVariant);
    return font.catalogId === selectedCatalogId || (matchesSearch && matchesCategory && matchesScript);
  });
  const value = browserFontSelectionValue(selection);

  return (
    <label className="grid min-w-0 gap-1.5 rounded-md border border-border/20 bg-muted/[0.08] p-2.5">
      <span className="text-xs font-semibold leading-5 text-foreground">{label}</span>
      <span className="min-h-8 text-[10px] leading-4 text-muted-foreground">{description}</span>
      <Select
        disabled={disabled}
        value={value}
        onValueChange={(nextValue) => onChange(slot, parseBrowserFontSelectionValue(nextValue))}
      >
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="fallback">{t("settings.browserFontsFallback")}</SelectItem>
          {selectedSystemFamily && !filteredSystemFonts.some((font) => font.family === selectedSystemFamily) ? (
            <SelectItem value={`system:${selectedSystemFamily}`}>{selectedSystemFamily}</SelectItem>
          ) : null}
          {selectedCatalogId && !filteredCatalog.some((font) => font.catalogId === selectedCatalogId) ? (
            <SelectItem value={`google:${selectedCatalogId}`}>{selectedCatalogId}</SelectItem>
          ) : null}
          {filteredSystemFonts.map((font) => (
            <SelectItem key={`system:${font.family}`} value={`system:${font.family}`}>
              {font.label} · {t("settings.browserFontsSourceSystem")}
            </SelectItem>
          ))}
          {filteredCatalog.map((font) => (
            <SelectItem key={`google:${font.catalogId}`} value={`google:${font.catalogId}`}>
              {font.family} · {font.installed
                ? t("settings.browserFontsInstalled")
                : t("settings.browserFontsNotDownloaded")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function BrowserFontsPreview({
  previewFamilies,
  settings,
  t
}: {
  previewFamilies: Record<string, string>;
  settings: GameBrowserSettings;
  t: Translator;
}): JSX.Element {
  const cjkFamily = browserFontPreviewFamily(settings.fonts.slots.cjk, previewFamilies);
  const latinFamily = browserFontPreviewFamily(settings.fonts.slots.latin, previewFamilies);
  const numericFamily = browserFontPreviewFamily(settings.fonts.slots.numeric, previewFamilies);
  const monospaceFamily = browserFontPreviewFamily(settings.fonts.slots.monospace, previewFamilies);
  const mathFamily = browserFontPreviewFamily(settings.fonts.slots.math, previewFamilies);

  return (
    <div className="grid gap-2 rounded-md border border-border/25 px-3 py-3 text-xs leading-5 text-muted-foreground">
      <p className="font-semibold text-foreground">{t("settings.browserFontsPreview")}</p>
      <p className="text-base leading-7">
        <span style={{ fontFamily: cjkFamily }}>繁體中文 · 简体中文 · 日本語 </span>
        <span style={{ fontFamily: latinFamily }}>Rion Studio </span>
        <span style={{ fontFamily: numericFamily }}>0123456789</span>
      </p>
      <p style={{ fontFamily: latinFamily }}>{t("settings.browserFontsPreviewText")}</p>
      <p style={{ fontFamily: monospaceFamily }}>const hp = 100; // 0123456789</p>
      <div
        style={{ fontFamily: mathFamily }}
        dangerouslySetInnerHTML={{
          __html:
            '<math style="font: inherit;"><mrow><msqrt><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></msqrt><mo>=</mo><mi>y</mi></mrow></math>'
        }}
      />
    </div>
  );
}

interface SettingsSectionProps {
  children: ReactNode;
  title?: string;
}

function SettingsSection({ children, title }: SettingsSectionProps): JSX.Element {
  return (
    <section className="grid gap-2">
      {title ? <h2 className="px-1 text-xs font-semibold leading-5 text-muted-foreground">{title}</h2> : null}
      <Surface className="settings-group overflow-hidden [&>*:last-child]:border-b-0" radius="md">
        {children}
      </Surface>
    </section>
  );
}

interface SettingsRowProps {
  control: ReactNode;
  description: ReactNode;
  showDivider?: boolean;
  title: ReactNode;
}

interface MacroBadgePositionSettingsRowsProps {
  settings: GameBrowserSettings;
  t: Translator;
  onError: (error: unknown) => void;
  onSave: (patch: GameBrowserSettingsPatch) => Promise<GameBrowserSettings>;
}

function MacroBadgePositionSettingsRows({
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
              <output className="w-14 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-foreground">
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
              <output className="w-14 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-foreground">
                {draft.horizontalMarginPx} px
              </output>
            </div>
          </div>
        }
      />
    </>
  );
}

function SettingsRow({ control, description, showDivider = true, title }: SettingsRowProps): JSX.Element {
  const dividerClassName = showDivider ? "glass-divider border-b last:border-b-0" : "";

  return (
    <div
      className={`settings-row flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${dividerClassName}`}
    >
      <div className="min-w-0">
        <p className="text-[13px] font-semibold leading-5 text-foreground">{title}</p>
        <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</div>
      </div>
      <div className="min-w-0 shrink-0 sm:w-auto">{control}</div>
    </div>
  );
}

function ReadOnlyValue({ value }: { value: string }): JSX.Element {
  return (
    <span className="glass-inset inline-flex h-[30px] max-w-full items-center truncate rounded-md px-2.5 text-[12px] font-semibold leading-none text-foreground sm:max-w-[320px]">
      {value}
    </span>
  );
}

function formatBrowserFontSettingsSummary(settings: GameBrowserSettings, t: Translator): string {
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

function getBrowserSystemFontOptions(
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

function getSelectedBrowserFontCatalogIds(settings: GameBrowserSettings): string[] {
  return [...new Set(
    browserFontSlots
      .map((slot) => settings.fonts.slots[slot])
      .filter((selection): selection is Extract<BrowserFontSelection, { source: "google" }> => selection?.source === "google")
      .map((selection) => selection.catalogId)
  )];
}

function resolveEffectiveBrowserFontCjkVariant(
  variant: BrowserFontCjkVariant,
  language: Language
): Exclude<BrowserFontCjkVariant, "auto"> {
  if (variant !== "auto") return variant;
  if (language === "zh-CN") return "sc";
  if (language === "ja") return "jp";
  return "tc";
}

function browserFontSelectionValue(selection?: BrowserFontSelection): string {
  if (!selection) return "fallback";
  return selection.source === "system"
    ? `system:${selection.family}`
    : `google:${selection.catalogId}`;
}

function parseBrowserFontSelectionValue(value: string): BrowserFontSelection | undefined {
  if (value.startsWith("system:")) return { source: "system", family: value.slice(7) };
  if (value.startsWith("google:")) return { source: "google", catalogId: value.slice(7) };
  return undefined;
}

function browserFontPreviewFamily(
  selection: BrowserFontSelection | undefined,
  previewFamilies: Record<string, string>
): string | undefined {
  if (!selection) return undefined;
  return selection.source === "system"
    ? selection.family
    : previewFamilies[selection.catalogId];
}

function decodeBrowserFontBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function formatBrowserFontBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function createPortableExportAvailability(counts: PortableDataCounts): PortableDataAvailability {
  return {
    games: counts.gameCount > 0,
    roles: counts.roleCount > 0,
    launchWorkspaces: counts.workspaceCount > 0,
    gameWindows: counts.gameWindowCount > 0,
    macros: counts.macroCount > 0,
    preferences: true
  };
}

function createPortableImportAvailability(preview: PortableImportPreview): PortableDataAvailability {
  return {
    games: preview.gameCount > 0,
    roles: preview.roleCount > 0,
    launchWorkspaces: preview.workspaceCount > 0,
    gameWindows: preview.gameWindowCount > 0,
    macros: preview.macroCount > 0,
    preferences: Boolean(preview.preferences)
  };
}

interface PortableExportDialogProps {
  availability: PortableDataAvailability;
  counts: PortableDataCounts;
  isBusy: boolean;
  selection: PortableDataSelection;
  t: Translator;
  onCancel: () => void;
  onChange: (selection: PortableDataSelection) => void;
  onConfirm: () => void;
}

function PortableExportDialog({
  availability,
  counts,
  isBusy,
  selection,
  t,
  onCancel,
  onChange,
  onConfirm
}: PortableExportDialogProps): JSX.Element {
  return (
    <div className="app-no-drag fixed inset-0 z-50 grid place-items-center bg-black/35 p-5 backdrop-blur-sm">
      <Surface
        className="flex max-h-[calc(100vh-2.5rem)] w-full max-w-[560px] flex-col overflow-hidden"
        radius="lg"
        variant="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="portable-export-title"
      >
        <div className="glass-divider border-b px-5 py-4">
          <h2 id="portable-export-title" className="text-[15px] font-semibold leading-6 text-foreground">
            {t("settings.exportSelectionTitle")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("settings.exportSelectionDescription")}
          </p>
        </div>

        <div className="grid gap-4 overflow-y-auto px-5 py-4">
          <PortableDataSelectionControls
            availability={availability}
            counts={counts}
            disabled={isBusy}
            selection={selection}
            t={t}
            onChange={onChange}
          />
          <p className="rounded-md border border-border/40 bg-background/25 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
            {t("settings.portableSafetyNotice")}
          </p>
        </div>

        <div className="glass-divider flex justify-end gap-2 border-t px-5 py-4">
          <Button type="button" variant="outline" disabled={isBusy} onClick={onCancel}>
            {t("settings.importCancel")}
          </Button>
          <Button
            type="button"
            disabled={isBusy || !hasPortableDataSelection(selection)}
            onClick={onConfirm}
          >
            <FileJson size={14} />
            {t("settings.exportJson")}
          </Button>
        </div>
      </Surface>
    </div>
  );
}

interface PortableImportDialogProps {
  isBusy: boolean;
  preview: PortableImportPreview;
  resolutions: PortableMacroConflictResolution[];
  selection: PortableDataSelection;
  t: Translator;
  onCancel: () => void;
  onChange: (selection: PortableDataSelection) => void;
  onConfirm: () => void;
  onResolutionsChange: (resolutions: PortableMacroConflictResolution[]) => void;
}

function PortableImportDialog({
  isBusy,
  preview,
  resolutions,
  selection,
  t,
  onCancel,
  onChange,
  onConfirm,
  onResolutionsChange
}: PortableImportDialogProps): JSX.Element {
  const availability = createPortableImportAvailability(preview);
  const selectedWarnings = filterPortableImportWarnings(preview.warnings, selection);
  const unresolvedConflictCount = selection.macros
    ? preview.conflicts.filter(
        (conflict) => !resolutions.some((resolution) => resolution.conflictId === conflict.id)
      ).length
    : 0;

  function updateConflictResolution(conflictId: string, value: string): void {
    const remaining = resolutions.filter((resolution) => resolution.conflictId !== conflictId);
    if (!value) {
      onResolutionsChange(remaining);
      return;
    }
    if (value === "copy" || value === "skip") {
      onResolutionsChange([...remaining, { conflictId, action: value }]);
      return;
    }
    onResolutionsChange([
      ...remaining,
      { conflictId, action: "update", targetMacroId: value.replace(/^update:/, "") }
    ]);
  }

  return (
    <div className="app-no-drag fixed inset-0 z-50 grid place-items-center bg-black/35 p-5 backdrop-blur-sm">
      <Surface
        className="flex max-h-[calc(100vh-2.5rem)] w-full max-w-[560px] flex-col overflow-hidden"
        radius="lg"
        variant="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="portable-import-title"
      >
        <div className="glass-divider border-b px-5 py-4">
          <h2 id="portable-import-title" className="text-[15px] font-semibold leading-6 text-foreground">
            {t("settings.importPreview")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("settings.importPreviewDescription")}</p>
        </div>

        <div className="grid gap-4 overflow-y-auto px-5 py-4">
          <PortableDataSelectionControls
            availability={availability}
            counts={preview}
            disabled={isBusy}
            selection={selection}
            t={t}
            onChange={onChange}
          />

          <PortableImportOperationsSummary
            operations={preview.operations}
            selection={selection}
            t={t}
          />

          {selection.macros && preview.conflicts.length > 0 ? (
            <div className="grid gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-3">
              <div>
                <p className="text-xs font-semibold leading-5 text-foreground">{t("settings.importConflictsTitle")}</p>
                <p className="text-[11px] leading-4 text-muted-foreground">
                  {t("settings.importConflictsDescription")}
                </p>
              </div>
              {preview.conflicts.map((conflict) => {
                const resolution = resolutions.find((item) => item.conflictId === conflict.id);
                const value = resolution?.action === "update"
                  ? `update:${resolution.targetMacroId}`
                  : resolution?.action ?? "";
                return (
                  <label key={conflict.id} className="grid gap-1.5">
                    <span className="text-xs font-semibold text-foreground">
                      {conflict.name} · {conflict.roleNames.join(", ")}
                    </span>
                    <select
                      className="h-9 rounded-md border border-border/50 bg-background px-2 text-xs text-foreground"
                      disabled={isBusy}
                      value={value}
                      onChange={(event) => updateConflictResolution(conflict.id, event.target.value)}
                    >
                      <option value="">{t("settings.importConflictChoose")}</option>
                      {conflict.candidates.map((candidate) => (
                        <option key={candidate.id} value={`update:${candidate.id}`}>
                          {t("settings.importConflictOverwrite")
                            .replace("{name}", candidate.name)
                            .replace("{steps}", String(candidate.stepCount))
                            .replace("{date}", new Date(candidate.updatedAt).toLocaleString())}
                        </option>
                      ))}
                      <option value="copy">{t("settings.importConflictCopy")}</option>
                      <option value="skip">{t("settings.importConflictSkip")}</option>
                    </select>
                  </label>
                );
              })}
            </div>
          ) : null}

          <div className="min-w-0 rounded-md border border-border/40 bg-background/25 px-3 py-2">
            <p className="truncate text-[11px] font-medium leading-4 text-muted-foreground">{preview.filePath}</p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              {formatPortableSource(preview, t)}
            </p>
          </div>

          {selectedWarnings.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-xs font-semibold leading-5 text-foreground">
                {t("settings.importWarnings").replace("{count}", String(selectedWarnings.length))}
              </p>
              <ul className="app-scroll-region max-h-36 space-y-1 overflow-auto text-xs leading-5 text-muted-foreground">
                {selectedWarnings.map((warning, index) => (
                  <li key={`${warning.code}-${warning.itemName ?? index}`}>
                    {formatPortableWarning(warning, t)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">{t("settings.importNoWarnings")}</p>
          )}
          <p className="rounded-md border border-border/40 bg-background/25 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
            {t("settings.importMergeSafetyNotice")}
          </p>
        </div>

        <div className="glass-divider flex justify-end gap-2 border-t px-5 py-4">
          <Button type="button" variant="outline" disabled={isBusy} onClick={onCancel}>
            {t("settings.importCancel")}
          </Button>
          <Button
            type="button"
            disabled={isBusy || !hasPortableDataSelection(selection) || unresolvedConflictCount > 0}
            onClick={onConfirm}
          >
            <Upload size={14} />
            {t("settings.importConfirm")}
          </Button>
        </div>
      </Surface>
    </div>
  );
}

function PortableImportOperationsSummary({
  operations,
  selection,
  t
}: {
  operations: PortableImportOperations;
  selection: PortableDataSelection;
  t: Translator;
}): JSX.Element {
  const items: Array<{
    key: keyof PortableImportOperations;
    labelKey: TranslationKey;
    selected: boolean;
  }> = [
    { key: "games", labelKey: "settings.importGames", selected: selection.games },
    { key: "roles", labelKey: "settings.importRoles", selected: selection.roles },
    { key: "launchWorkspaces", labelKey: "settings.importWorkspaces", selected: selection.launchWorkspaces },
    { key: "gameWindows", labelKey: "settings.importGameWindows", selected: selection.gameWindows },
    { key: "macros", labelKey: "settings.importMacros", selected: selection.macros }
  ];
  return (
    <div className="grid gap-1.5 rounded-md border border-border/40 bg-background/25 px-3 py-2">
      {items.filter((item) => item.selected).map((item) => {
        const summary = operations[item.key];
        return (
          <div key={item.key} className="flex items-center justify-between gap-3 text-[11px] leading-4">
            <span className="font-semibold text-foreground">{t(item.labelKey)}</span>
            <span className="text-right tabular-nums text-muted-foreground">
              {t("settings.importOperationSummary")
                .replace("{create}", String(summary.create))
                .replace("{update}", String(summary.update))
                .replace("{unchanged}", String(summary.unchanged))
                .replace("{skip}", String(summary.skip))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface PortableDataSelectionControlsProps {
  availability: PortableDataAvailability;
  counts: PortableDataCounts;
  disabled: boolean;
  selection: PortableDataSelection;
  t: Translator;
  onChange: (selection: PortableDataSelection) => void;
}

function PortableDataSelectionControls({
  availability,
  counts,
  disabled,
  selection,
  t,
  onChange
}: PortableDataSelectionControlsProps): JSX.Element {
  const roleSelectionRequired = isPortableRoleSelectionRequired(selection);
  const gameSelectionRequired = isPortableGameSelectionRequired(selection);
  const workspaceSelectionRequired = isPortableWorkspaceSelectionRequired(selection);
  const items: Array<{
    count?: number;
    descriptionKey: TranslationKey;
    labelKey: TranslationKey;
    section: PortableDataSection;
  }> = [
    {
      count: counts.gameCount,
      descriptionKey: "settings.portableGamesDescription",
      labelKey: "settings.importGames",
      section: "games"
    },
    {
      count: counts.roleCount,
      descriptionKey: "settings.portableRolesDescription",
      labelKey: "settings.importRoles",
      section: "roles"
    },
    {
      count: counts.workspaceCount,
      descriptionKey: "settings.portableWorkspacesDescription",
      labelKey: "settings.importWorkspaces",
      section: "launchWorkspaces"
    },
    {
      count: counts.gameWindowCount,
      descriptionKey: "settings.portableGameWindowsDescription",
      labelKey: "settings.importGameWindows",
      section: "gameWindows"
    },
    {
      count: counts.macroCount,
      descriptionKey: "settings.portableMacrosDescription",
      labelKey: "settings.importMacros",
      section: "macros"
    },
    {
      descriptionKey: "settings.portablePreferencesDescription",
      labelKey: "settings.portablePreferences",
      section: "preferences"
    }
  ];

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold leading-5 text-foreground">{t("settings.portableChooseData")}</p>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(createDefaultPortableDataSelection(availability))}
          >
            {t("settings.portableSelectAll")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(clearPortableDataSelection())}
          >
            {t("settings.portableClearAll")}
          </Button>
        </div>
      </div>

      <div className="grid gap-2">
        {items.map(({ count, descriptionKey, labelKey, section }) => {
          const isAvailable = availability[section];
          const isRoleLocked = section === "roles" && roleSelectionRequired;
          const isGameLocked = section === "games" && gameSelectionRequired;
          const isWorkspaceLocked = section === "launchWorkspaces" && workspaceSelectionRequired;
          const itemDisabled = disabled || !isAvailable || isRoleLocked || isGameLocked || isWorkspaceLocked;
          const description = isRoleLocked
            ? t("settings.portableRolesRequired")
            : isGameLocked
              ? t("settings.portableGamesRequired")
              : isWorkspaceLocked
                ? t("settings.portableWorkspacesRequired")
                : t(descriptionKey);

          return (
            <label
              key={section}
              className={`glass-inset flex min-h-14 items-center gap-3 rounded-md px-3 py-2.5 ${
                itemDisabled ? "opacity-60" : "cursor-pointer"
              }`}
            >
              <Checkbox
                checked={selection[section]}
                disabled={itemDisabled}
                onCheckedChange={(checked) =>
                  onChange(
                    updatePortableDataSelection(selection, section, checked === true, availability)
                  )
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold leading-5 text-foreground">{t(labelKey)}</span>
                <span className="block text-[11px] leading-4 text-muted-foreground">
                  {isAvailable ? description : t("settings.portableUnavailable")}
                </span>
              </span>
              <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
                {count ?? (isAvailable ? t("settings.portableIncluded") : "—")}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function formatPortableExportResult(result: PortableExportResult, t: Translator): string {
  return t("settings.exportComplete").replace("{summary}", formatPortableResultSummary(result, t));
}

function formatPortableImportResult(result: PortableImportResult, t: Translator): string {
  const selectedOperations = [
    result.selection.games ? result.operations.games : undefined,
    result.selection.roles ? result.operations.roles : undefined,
    result.selection.launchWorkspaces ? result.operations.launchWorkspaces : undefined,
    result.selection.gameWindows ? result.operations.gameWindows : undefined,
    result.selection.macros ? result.operations.macros : undefined
  ].filter((summary): summary is PortableImportOperations[keyof PortableImportOperations] => Boolean(summary));
  const totals = selectedOperations.reduce(
    (summary, item) => ({
      create: summary.create + item.create,
      update: summary.update + item.update,
      unchanged: summary.unchanged + item.unchanged,
      skip: summary.skip + item.skip
    }),
    { create: 0, update: 0, unchanged: 0, skip: 0 }
  );
  const summary = t("settings.importOperationSummary")
    .replace("{create}", String(totals.create))
    .replace("{update}", String(totals.update))
    .replace("{unchanged}", String(totals.unchanged))
    .replace("{skip}", String(totals.skip));
  return t("settings.importComplete").replace(
    "{summary}",
    result.preferencesIncluded ? `${summary} · ${t("settings.portablePreferences")}` : summary
  );
}

function formatPortableResultSummary(
  result: PortableExportResult | PortableImportResult,
  t: Translator
): string {
  const parts: string[] = [];

  if (result.selection.games) {
    parts.push(formatPortableCountSummary(t("settings.importGames"), result.gameCount, t));
  }
  if (result.selection.roles) {
    parts.push(formatPortableCountSummary(t("settings.importRoles"), result.roleCount, t));
  }
  if (result.selection.launchWorkspaces) {
    parts.push(formatPortableCountSummary(t("settings.importWorkspaces"), result.workspaceCount, t));
  }
  if (result.selection.gameWindows) {
    parts.push(formatPortableCountSummary(t("settings.importGameWindows"), result.gameWindowCount, t));
  }
  if (result.selection.macros) {
    parts.push(formatPortableCountSummary(t("settings.importMacros"), result.macroCount, t));
  }
  if (result.preferencesIncluded) {
    parts.push(t("settings.portablePreferences"));
  }

  return parts.join(" · ");
}

function formatPortableCountSummary(label: string, count: number, t: Translator): string {
  return t("settings.portableCountSummary")
    .replace("{label}", label)
    .replace("{count}", String(count));
}

function formatPortableSource(preview: PortableImportPreview, t: Translator): string {
  const exportedAt = preview.exportedAt ? new Date(preview.exportedAt).toLocaleString() : t("settings.importUnknown");
  const appVersion = preview.appVersion || t("settings.importUnknown");

  return t("settings.importSource")
    .replace("{version}", appVersion)
    .replace("{date}", exportedAt);
}

function formatPortableWarning(warning: PortableImportWarning, t: Translator): string {
  const itemName = warning.itemName ?? t("settings.importUnknown");
  const replacementName = warning.replacementName ?? t("settings.importUnknown");
  const count = String(warning.count ?? 0);

  switch (warning.code) {
    case "GAME_NAME_RENAMED":
      return t("settings.warningGameRenamed").replace("{name}", itemName).replace("{next}", replacementName);
    case "BUILTIN_GAME_DEFAULTS_REPLACED":
      return t("settings.warningBuiltinGameReplaced").replace("{name}", itemName);
    case "ROLE_GAME_RECOVERED":
      return t("settings.warningRoleGameRecovered").replace("{name}", itemName);
    case "ROLE_NAME_RENAMED":
      return t("settings.warningRoleRenamed").replace("{name}", itemName).replace("{next}", replacementName);
    case "ROLE_LOCAL_STORAGE_SOURCE_MISSING":
      return t("settings.warningRoleLocalStorageSourceMissing").replace("{name}", itemName);
    case "ROLE_LOCAL_STORAGE_BINDING_INVALID":
      return t("settings.warningRoleLocalStorageBindingInvalid").replace("{name}", itemName);
    case "WORKSPACE_NAME_RENAMED":
      return t("settings.warningWorkspaceRenamed").replace("{name}", itemName).replace("{next}", replacementName);
    case "WORKSPACE_ROLE_MISSING":
      return t("settings.warningWorkspaceRoleMissing").replace("{name}", itemName).replace("{count}", count);
    case "GAME_WINDOW_NAME_RENAMED":
      return t("settings.warningGameWindowRenamed").replace("{name}", itemName).replace("{next}", replacementName);
    case "GAME_WINDOW_TAB_DEPENDENCY_MISSING":
      return t("settings.warningGameWindowTabDependencyMissing").replace("{name}", itemName);
    case "GAME_WINDOW_TAB_ROLE_CONFLICT":
      return t("settings.warningGameWindowTabRoleConflict").replace("{name}", itemName);
    case "MACRO_NAME_RENAMED":
      return t("settings.warningMacroRenamed").replace("{name}", itemName).replace("{next}", replacementName);
    case "MACRO_ROLE_MISSING":
      return t("settings.warningMacroRoleMissing").replace("{name}", itemName).replace("{count}", count);
    case "MACRO_SHORTCUT_CLEARED_CONFLICT":
      return t("settings.warningMacroShortcutConflict").replace("{name}", itemName);
    case "MACRO_SHORTCUT_CLEARED_RESERVED":
      return t("settings.warningMacroShortcutReserved").replace("{name}", itemName);
    case "MACRO_SKIPPED_NO_ROLES":
      return t("settings.warningMacroSkipped").replace("{name}", itemName);
    case "MACRO_SKIPPED_MISSING_DEPENDENCY":
      return t("settings.warningMacroDependencySkipped").replace("{name}", itemName);
    default:
      return t("settings.warningUnknown");
  }
}

function formatUpdateStatus(status: AppUpdateStatus | null, t: Translator): string {
  if (!status) {
    return t("settings.updateStatusLoading");
  }

  if (status.state === "downloaded" && status.availableVersion) {
    return t("settings.updateDownloaded").replace("{version}", status.availableVersion);
  }

  if (status.state === "downloading") {
    return t("settings.updateDownloading").replace("{progress}", String(status.downloadProgress ?? 0));
  }

  if (status.state === "available" && status.availableVersion) {
    if (status.installMode === "manual") {
      return t("settings.updateManualAvailable").replace("{version}", status.availableVersion);
    }

    return t("settings.updateAvailable").replace("{version}", status.availableVersion);
  }

  if (status.state === "error") {
    return t("settings.updateError").replace("{error}", status.error ?? t("settings.updateErrorUnknown"));
  }

  return t(`settings.updateState.${status.state}`);
}

function SettingsView(props: SettingsViewProps): JSX.Element {
  const [searchParams] = useSearchParams();
  const activeSection = readSettingsSection(searchParams.get("section"));

  return <SettingsViewBase {...props} activeSection={activeSection} />;
}

export default SettingsView;
