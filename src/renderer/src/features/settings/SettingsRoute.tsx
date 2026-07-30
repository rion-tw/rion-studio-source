import { Check, ChevronDown, CloudDownload, Download, Eye, FileJson, FileText, Laptop, Loader2, Moon, PenLine, RefreshCw, RotateCcw, Search, Settings2, SlidersHorizontal, Sparkles, Sun, Trash2, TriangleAlert, Type, Upload } from "lucide-react";
import { type JSX, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../../components/ui/dropdown-menu";
import { LegalDocumentDialog } from "../legal/LegalDocumentDialog";
import type { LegalDocumentKind } from "../legal/legalDocuments";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Slider } from "../../components/ui/slider";
import { Switch } from "../../components/ui/switch";
import { PageFrame, SegmentedControl, SettingsRow, SettingsSection, StatusCallout, Surface } from "../../components/ui/patterns";
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
  normalizeBrowserFontFamily,
  normalizeGameBrowserSettings,
  resolveBrowserFontPreset,
  type BrowserFontPresetId,
  workspaceGapSizes
} from "../../../../shared/browserFonts";
import {
  macroBadgeHorizontalMarginsPx,
  macroBadgeTopPositionsPx
} from "../../../../shared/macroOverlay";
import { getLegalDocumentVersion, LEGAL_PROVIDER_NAME } from "../../../../shared/legal";
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
import {
  getGoogleFontPreviewStatus,
  quoteFontFamily,
  requestGoogleFontPreview,
  retryGoogleFontPreview,
  subscribeGoogleFontPreview,
  type GoogleFontPreviewStatus
} from "./googleFontPreview";

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
  "high-legibility": "settings.browserFonts.preset.highLegibility",
  "compact-dashboard": "settings.browserFonts.preset.compactDashboard",
  "natural-handwriting": "settings.browserFonts.preset.naturalHandwriting",
  "playful-handwriting": "settings.browserFonts.preset.playfulHandwriting",
  "calligraphic-handwriting": "settings.browserFonts.preset.calligraphicHandwriting",
  "neat-notebook": "settings.browserFonts.preset.neatNotebook",
  "storybook-handwriting": "settings.browserFonts.preset.storybookHandwriting",
  "friendly-rounded": "settings.browserFonts.preset.friendlyRounded",
  "marker-notes": "settings.browserFonts.preset.markerNotes",
  "editorial-serif": "settings.browserFonts.preset.editorialSerif",
  "retro-game": "settings.browserFonts.preset.retroGame",
  "fantasy-chronicle": "settings.browserFonts.preset.fantasyChronicle",
  "future-interface": "settings.browserFonts.preset.futureInterface",
  "relaxed-dialogue": "settings.browserFonts.preset.relaxedDialogue"
};

const browserFontPresetDescriptionKeys: Record<BrowserFontPresetId, TranslationKey> = {
  "system-default": "settings.browserFonts.preset.systemDefaultDescription",
  "modern-sans": "settings.browserFonts.preset.modernSansDescription",
  "comfortable-reading": "settings.browserFonts.preset.comfortableReadingDescription",
  "clear-interface": "settings.browserFonts.preset.clearInterfaceDescription",
  "clear-numbers": "settings.browserFonts.preset.clearNumbersDescription",
  "code-monospace": "settings.browserFonts.preset.codeMonospaceDescription",
  "high-legibility": "settings.browserFonts.preset.highLegibilityDescription",
  "compact-dashboard": "settings.browserFonts.preset.compactDashboardDescription",
  "natural-handwriting": "settings.browserFonts.preset.naturalHandwritingDescription",
  "playful-handwriting": "settings.browserFonts.preset.playfulHandwritingDescription",
  "calligraphic-handwriting": "settings.browserFonts.preset.calligraphicHandwritingDescription",
  "neat-notebook": "settings.browserFonts.preset.neatNotebookDescription",
  "storybook-handwriting": "settings.browserFonts.preset.storybookHandwritingDescription",
  "friendly-rounded": "settings.browserFonts.preset.friendlyRoundedDescription",
  "marker-notes": "settings.browserFonts.preset.markerNotesDescription",
  "editorial-serif": "settings.browserFonts.preset.editorialSerifDescription",
  "retro-game": "settings.browserFonts.preset.retroGameDescription",
  "fantasy-chronicle": "settings.browserFonts.preset.fantasyChronicleDescription",
  "future-interface": "settings.browserFonts.preset.futureInterfaceDescription",
  "relaxed-dialogue": "settings.browserFonts.preset.relaxedDialogueDescription"
};

const browserFontPresetCategories = ["general", "handwriting", "personality"] as const;
type BrowserFontPresetCategory = (typeof browserFontPresetCategories)[number];

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
      className="settings-page"
      contentClassName="mx-auto flex min-h-full w-full max-w-[840px] flex-col gap-8"
    >
      <header className="settings-page-header">
        <h1 className="text-page-title font-bold text-foreground">{pageTitle}</h1>
        <p className="mt-2 max-w-2xl text-body text-muted-foreground">{pageDescription}</p>
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
              {isMacOS ? (
                <SettingsRow
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

            <SettingsSection title={t("settings.gameFonts")}>
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
                title={t("settings.alwaysShowToolbarInFullScreen")}
                description={t("settings.alwaysShowToolbarInFullScreenDescription")}
                control={
                  <Switch
                    aria-label={t("settings.alwaysShowToolbarInFullScreen")}
                    checked={runtimeWindowPreferences.alwaysShowToolbarInFullScreen}
                    disabled={isRuntimeWindowPreferencesSaving}
                    onCheckedChange={(alwaysShowToolbarInFullScreen) => {
                      setIsRuntimeWindowPreferencesSaving(true);
                      void onRuntimeWindowPreferencesChange({
                        ...runtimeWindowPreferences,
                        alwaysShowToolbarInFullScreen
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
                  description={t("legal.version").replace("{version}", getLegalDocumentVersion(kind))}
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
  const [savedSettings, setSavedSettings] = useState<GameBrowserSettings>(() =>
    normalizeGameBrowserSettings(settings)
  );
  const [availableFonts, setAvailableFonts] = useState<SystemFontFamily[]>(systemFonts);
  const [catalog, setCatalog] = useState<BrowserFontCatalogEntry[]>([]);
  const [isLoadingFonts, setIsLoadingFonts] = useState(systemFonts.length === 0);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
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
        <div className="glass-divider border-b bg-background/[0.035]">
          <div className="settings-row glass-divider grid gap-3 border-b px-4 py-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-body font-semibold text-foreground">
                <Type className="size-3.5 text-muted-foreground" aria-hidden="true" />
                {t("settings.browserFontsPresets")}
              </p>
              <p className="mt-0.5 text-control text-muted-foreground">
                {t("settings.browserFontsPresetsDescription")}
              </p>
            </div>
            <BrowserFontPresetCards
              activePresetId={draft.fonts.presetId}
              catalog={catalog}
              cjkVariant={effectiveCjkVariant}
              disabled={isSaving}
              previewEnabled={isExpanded}
              t={t}
              onSelect={handlePresetChange}
            />
            <StatusCallout className="leading-5" tone="warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{t("settings.browserFontsForceWarning")}</span>
            </StatusCallout>
          </div>

          <div className="settings-row glass-divider flex items-start gap-3 border-b px-4 py-3">
            <SlidersHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div>
              <p className="text-body font-semibold text-foreground">
                {t("settings.browserFontsFineTune")}
              </p>
              <p className="mt-0.5 text-control text-muted-foreground">
                {t("settings.browserFontsFineTuneDescription")}
              </p>
            </div>
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
          </div>

          <details className="settings-row glass-divider group border-b px-4 py-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
              <div className="flex min-w-0 items-start gap-3">
                <Settings2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-body font-semibold text-foreground">
                    {t("settings.browserFontsAdvanced")}
                  </p>
                  <p className="mt-0.5 text-control text-muted-foreground">
                    {t("settings.browserFontsAdvancedDescription")}
                  </p>
                </div>
              </div>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-4 grid gap-4 border-t border-border/25 pt-4">
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
                  installedFonts.map((font) => {
                    const isSelected = selectedCatalogIds.includes(font.catalogId);
                    return (
                      <div key={font.catalogId} className="flex items-center justify-between gap-3 rounded-md bg-muted/20 px-2.5 py-2">
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
                  })
                )}
              </div>
              <p className="text-caption leading-5 text-muted-foreground">
                {t("settings.browserFontsGoogleNotice")}
              </p>
            </div>
          </details>

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
    </>
  );
}

interface BrowserFontPresetCardsProps {
  activePresetId?: string;
  catalog: BrowserFontCatalogEntry[];
  cjkVariant: Exclude<BrowserFontCjkVariant, "auto">;
  disabled: boolean;
  previewEnabled: boolean;
  t: Translator;
  onSelect: (presetId: BrowserFontPresetId) => void;
}

function BrowserFontPresetCards({
  activePresetId,
  catalog,
  cjkVariant,
  disabled,
  previewEnabled,
  t,
  onSelect
}: BrowserFontPresetCardsProps): JSX.Element {
  const activePresetCategory = browserFontPresets.find((preset) => preset.id === activePresetId)?.category ?? "general";
  const [selectedCategory, setSelectedCategory] = useState<BrowserFontPresetCategory>(activePresetCategory);

  useEffect(() => {
    const nextCategory = browserFontPresets.find((preset) => preset.id === activePresetId)?.category;
    if (nextCategory) setSelectedCategory(nextCategory);
  }, [activePresetId]);

  return (
    <div className="grid gap-2.5">
      <SegmentedControl<BrowserFontPresetCategory>
        className="grid-cols-3"
        disabled={disabled}
        items={browserFontPresetCategories.map((category) => ({
          value: category,
          count: browserFontPresets.filter((preset) => preset.category === category).length,
          icon: category === "general" ? Type : category === "handwriting" ? PenLine : Sparkles,
          label: t(
            category === "general"
              ? "settings.browserFontsPresetsGeneral"
              : category === "handwriting"
                ? "settings.browserFontsPresetsHandwriting"
                : "settings.browserFontsPresetsPersonality"
          )
        }))}
        value={selectedCategory}
        onValueChange={setSelectedCategory}
      />

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {browserFontPresets
          .filter((preset) => preset.category === selectedCategory)
          .map((preset) => {
            const isActive = activePresetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={isActive}
                disabled={disabled}
                className={`group min-h-[104px] rounded-md border px-3 py-2.5 text-left transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25 disabled:opacity-45 ${
                  isActive
                    ? "border-activity/45 bg-activity/[0.08] text-foreground shadow-[inset_0_1px_0_hsl(var(--glass-highlight-muted))]"
                    : "border-border/25 bg-muted/[0.07] text-muted-foreground hover:border-border/40 hover:bg-accent/25 hover:text-foreground"
                }`}
                onClick={() => onSelect(preset.id)}
              >
                <span className="flex items-start justify-between gap-2 text-xs font-semibold leading-5">
                  <span>{t(browserFontPresetLabelKeys[preset.id])}</span>
                  {isActive ? <Check className="mt-0.5 size-3.5 shrink-0 text-activity" aria-hidden="true" /> : null}
                </span>
                <span className="mt-0.5 block text-micro leading-4">
                  {t(browserFontPresetDescriptionKeys[preset.id])}
                </span>
                <BrowserFontPresetSample
                  catalog={catalog}
                  cjkVariant={cjkVariant}
                  enabled={previewEnabled}
                  presetId={preset.id}
                />
              </button>
            );
          })}
      </div>
    </div>
  );
}

function BrowserFontPresetSample({
  catalog,
  cjkVariant,
  enabled,
  presetId
}: {
  catalog: BrowserFontCatalogEntry[];
  cjkVariant: Exclude<BrowserFontCjkVariant, "auto">;
  enabled: boolean;
  presetId: BrowserFontPresetId;
}): JSX.Element {
  const settings = resolveBrowserFontPreset(presetId, cjkVariant);
  return (
    <span className="mt-2 flex min-w-0 items-baseline gap-2 overflow-hidden rounded-sm border border-border/15 bg-background/20 px-2 py-1 text-sm text-foreground">
      <BrowserFontSample
        catalog={catalog}
        enabled={enabled}
        selection={settings.slots.cjk}
        text={browserFontSampleText("cjk", cjkVariant)}
      />
      <BrowserFontSample
        catalog={catalog}
        enabled={enabled}
        selection={settings.slots.latin}
        text="Aa"
      />
      <BrowserFontSample
        catalog={catalog}
        enabled={enabled}
        selection={settings.slots.numeric}
        text="0123"
      />
    </span>
  );
}

interface BrowserFontSelectionPickerProps {
  catalog: BrowserFontCatalogEntry[];
  cjkVariant: Exclude<BrowserFontCjkVariant, "auto">;
  disabled: boolean;
  label: string;
  previewEnabled: boolean;
  selection?: BrowserFontSelection;
  slot: BrowserFontSlot;
  systemFonts: SystemFontFamily[];
  t: Translator;
  onChange: (slot: BrowserFontSlot, selection: BrowserFontSelection | undefined) => void;
}

function BrowserFontSample({
  catalog,
  enabled,
  selection,
  text
}: {
  catalog: BrowserFontCatalogEntry[];
  enabled: boolean;
  selection?: BrowserFontSelection;
  text: string;
}): JSX.Element {
  const sampleRef = useRef<HTMLSpanElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIsVisible(false);
      return;
    }
    const element = sampleRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "80px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);

  const preview = useBrowserFontPreview(selection, catalog, text, enabled && isVisible);
  return (
    <span
      ref={sampleRef}
      aria-hidden="true"
      className={`shrink-0 whitespace-nowrap text-sm transition-opacity ${
        preview.status === "loading" ? "animate-pulse opacity-45" : "opacity-85"
      }`}
      style={preview.fontFamily ? { fontFamily: preview.fontFamily } : undefined}
    >
      {text}
    </span>
  );
}

function BrowserFontSelectionPicker({
  catalog,
  cjkVariant,
  disabled,
  label,
  previewEnabled,
  selection,
  slot,
  systemFonts,
  t,
  onChange
}: BrowserFontSelectionPickerProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | BrowserFontCategory>("all");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const query = search.trim().toLocaleLowerCase();
  const filteredSystemFonts = systemFonts
    .filter(
      (font) =>
        !query ||
        font.family.toLocaleLowerCase().includes(query) ||
        font.label.toLocaleLowerCase().includes(query)
    )
    .sort((left, right) => left.label.localeCompare(right.label));
  const filteredCatalog = catalog
    .filter((font) => {
      const isCustomGoogleFont = font.catalogId.startsWith("custom-");
      const matchesSearch =
        !query ||
        font.family.toLocaleLowerCase().includes(query) ||
        font.catalogId.toLocaleLowerCase().includes(query);
      const matchesCategory =
        isCustomGoogleFont || category === "all" || font.category === category;
      const matchesScript =
        isCustomGoogleFont || slot !== "cjk" || font.scripts.includes(cjkVariant);
      return matchesSearch && matchesCategory && matchesScript;
    })
    .sort((left, right) => left.family.localeCompare(right.family));
  const value = browserFontSelectionValue(selection);
  const selectedLabel = browserFontSelectionLabel(selection, systemFonts, catalog, t);
  const hasFontResults = filteredSystemFonts.length > 0 || filteredCatalog.length > 0;

  useEffect(() => {
    if (!isOpen) return;
    const animationFrame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [isOpen]);

  function handleOpenChange(nextOpen: boolean): void {
    setIsOpen(nextOpen);
    if (!nextOpen) setSearch("");
  }

  function handleValueChange(nextValue: string): void {
    onChange(slot, parseBrowserFontSelectionValue(nextValue, catalog));
    setSearch("");
    setIsOpen(false);
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="settings-menu-control w-full justify-between overflow-hidden px-2.5 font-normal sm:w-80"
            aria-label={label}
            disabled={disabled}
          >
            <span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>
            <ChevronDown
              className={isOpen ? "size-3 rotate-180 transition-transform duration-150" : "size-3 transition-transform duration-150"}
              aria-hidden="true"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[min(440px,calc(100vw-1rem))] min-w-[var(--radix-dropdown-menu-trigger-width)] p-0"
        >
          <div className="grid gap-1.5 p-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" aria-hidden="true" />
              <Input
                ref={searchInputRef}
                className="pl-8"
                aria-label={t("settings.browserFontsSearchForSlot").replace("{slot}", label)}
                placeholder={t("settings.browserFontsSearchPlaceholder")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    const firstResult = resultsRef.current?.querySelector<HTMLElement>(
                      query
                        ? '[data-font-option]:not([data-disabled])'
                        : '[role="menuitemradio"]:not([data-disabled])'
                    );
                    if (firstResult) {
                      event.preventDefault();
                      firstResult.focus();
                    }
                    return;
                  }
                  if (event.key !== "Escape" && event.key !== "Tab") {
                    event.stopPropagation();
                  }
                }}
              />
            </div>
            <Select
              value={category}
              onValueChange={(value) => setCategory(value as "all" | BrowserFontCategory)}
            >
              <SelectTrigger className="w-full" aria-label={t("settings.browserFontsCategory")}>
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
          <DropdownMenuSeparator className="m-0" />
          <div ref={resultsRef} className="max-h-60 overflow-y-auto p-1">
            <DropdownMenuRadioGroup value={value} onValueChange={handleValueChange}>
              <DropdownMenuRadioItem value="fallback">
                {t("settings.browserFontsFallback")}
              </DropdownMenuRadioItem>

              {filteredSystemFonts.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t("settings.browserFontsSourceSystem")}</DropdownMenuLabel>
                  {filteredSystemFonts.map((font) => (
                    <DropdownMenuRadioItem
                      key={`system:${font.family}`}
                      value={`system:${font.family}`}
                      data-font-option
                    >
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                        <span className="min-w-0 truncate">
                          {font.label} · {t("settings.browserFontsSourceSystem")}
                        </span>
                        <BrowserFontSample
                          catalog={catalog}
                          enabled={previewEnabled && isOpen}
                          selection={{ source: "system", family: font.family }}
                          text={browserFontSampleText(slot, cjkVariant)}
                        />
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </>
              ) : null}

              {filteredCatalog.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t("settings.browserFontsSourceGoogle")}</DropdownMenuLabel>
                  {filteredCatalog.map((font) => (
                    <DropdownMenuRadioItem
                      key={`google:${font.catalogId}`}
                      value={`google:${font.catalogId}`}
                      data-font-option
                    >
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                        <span className="min-w-0 truncate">
                          {font.family} · {font.installed
                            ? t("settings.browserFontsInstalled")
                            : t("settings.browserFontsNotDownloaded")}
                        </span>
                        <BrowserFontSample
                          catalog={catalog}
                          enabled={previewEnabled && isOpen}
                          selection={{ source: "google", catalogId: font.catalogId, family: font.family }}
                          text={browserFontSampleText(slot, cjkVariant)}
                        />
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </>
              ) : null}

              {!hasFontResults ? (
                <p role="status" className="px-2 py-3 text-center text-caption text-muted-foreground">
                  {t("settings.browserFontsNoResults")}
                </p>
              ) : null}
            </DropdownMenuRadioGroup>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
  );
}

function BrowserFontsPreview({
  catalog,
  cjkVariant,
  previewFamilies,
  previewEnabled,
  settings,
  t
}: {
  catalog: BrowserFontCatalogEntry[];
  cjkVariant: Exclude<BrowserFontCjkVariant, "auto">;
  previewFamilies: Record<string, string>;
  previewEnabled: boolean;
  settings: GameBrowserSettings;
  t: Translator;
}): JSX.Element {
  const cjkText = `繁體中文 简体中文 日本語 ${browserFontSampleText("cjk", cjkVariant)}`;
  const latinText = `Rion Studio ${t("settings.browserFontsPreviewText")}`;
  const numericText = "0123456789 1,234.56 -20% 08:45 100/75";
  const monospaceText = "const hp = 100; // 0123456789";
  const mathText = "√x+1=y";
  const cjk = useBrowserFontPreview(
    settings.fonts.slots.cjk,
    catalog,
    cjkText,
    previewEnabled,
    previewFamilies
  );
  const latin = useBrowserFontPreview(
    settings.fonts.slots.latin,
    catalog,
    latinText,
    previewEnabled,
    previewFamilies
  );
  const numeric = useBrowserFontPreview(
    settings.fonts.slots.numeric,
    catalog,
    numericText,
    previewEnabled,
    previewFamilies
  );
  const monospace = useBrowserFontPreview(
    settings.fonts.slots.monospace,
    catalog,
    monospaceText,
    previewEnabled,
    previewFamilies
  );
  const math = useBrowserFontPreview(
    settings.fonts.slots.math,
    catalog,
    mathText,
    previewEnabled,
    previewFamilies
  );
  const previews = [cjk, latin, numeric, monospace, math];
  const hasLoadingPreview = previews.some((preview) => preview.status === "loading");
  const failedPreviews = previews.filter((preview) => preview.status === "error" && !preview.hasLocalFallback);

  return (
    <div className="grid gap-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-body font-semibold text-foreground">
          <Eye className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("settings.browserFontsOnlinePreview")}
          {hasLoadingPreview ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
        </p>
        <p className="mt-0.5 text-control text-muted-foreground">
          {t("settings.browserFontsOnlinePreviewDescription")}
        </p>
      </div>
      <Surface className="grid gap-2 border border-border/25 px-3 py-3 text-xs leading-5 text-muted-foreground" variant="inset">
        <p className="text-base leading-7">
          <span style={fontPreviewStyle(cjk)}>繁體中文 · 简体中文 · 日本語 </span>
          <span style={fontPreviewStyle(latin)}>Rion Studio </span>
          <span style={fontPreviewStyle(numeric)}>0123456789</span>
        </p>
        <p className="text-base leading-6 tracking-wide" style={fontPreviewStyle(numeric)}>
          1,234.56 · -20% · 08:45 · 100/75
        </p>
        <p style={fontPreviewStyle(latin)}>{t("settings.browserFontsPreviewText")}</p>
        <p style={fontPreviewStyle(monospace)}>const hp = 100; // 0123456789</p>
        <div
          style={fontPreviewStyle(math)}
          dangerouslySetInnerHTML={{
            __html:
              '<math style="font: inherit;"><mrow><msqrt><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></msqrt><mo>=</mo><mi>y</mi></mrow></math>'
          }}
        />
      </Surface>
      {failedPreviews.length > 0 ? (
        <StatusCallout tone="warning" role="status">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{t("settings.browserFontsPreviewFailed")}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => failedPreviews.forEach((preview) => preview.retry())}
          >
            <RefreshCw size={13} />
            {t("settings.browserFontsPreviewRetry")}
          </Button>
        </StatusCallout>
      ) : null}
    </div>
  );
}

interface ResolvedBrowserFontPreview {
  fontFamily?: string;
  hasLocalFallback: boolean;
  retry: () => void;
  status: GoogleFontPreviewStatus;
}

function useBrowserFontPreview(
  selection: BrowserFontSelection | undefined,
  catalog: BrowserFontCatalogEntry[],
  text: string,
  enabled: boolean,
  localFamilies: Record<string, string> = {}
): ResolvedBrowserFontPreview {
  const resolved = resolveBrowserFontPreviewFamily(selection, catalog);
  const localFamily = selection?.source === "google" ? localFamilies[selection.catalogId] : undefined;
  const [status, setStatus] = useState<GoogleFontPreviewStatus>(() =>
    resolved.source === "google"
      ? getGoogleFontPreviewStatus(resolved.family ?? "", text)
      : resolved.family
        ? "loaded"
        : "idle"
  );

  useEffect(() => {
    if (resolved.source !== "google" || !resolved.family || !enabled) {
      setStatus(resolved.family && resolved.source === "system" ? "loaded" : "idle");
      return;
    }
    const unsubscribe = subscribeGoogleFontPreview(resolved.family, text, setStatus);
    requestGoogleFontPreview(resolved.family, text);
    return unsubscribe;
  }, [enabled, resolved.family, resolved.source, text]);

  const remoteFamily = resolved.source === "google" && status === "loaded" ? resolved.family : undefined;
  const activeFamily = resolved.source === "system" ? resolved.family : remoteFamily ?? localFamily;
  return {
    ...(activeFamily ? { fontFamily: quoteFontFamily(activeFamily) } : {}),
    hasLocalFallback: Boolean(localFamily),
    retry: () => {
      if (resolved.source === "google" && resolved.family) {
        retryGoogleFontPreview(resolved.family, text);
      }
    },
    status
  };
}

function resolveBrowserFontPreviewFamily(
  selection: BrowserFontSelection | undefined,
  catalog: BrowserFontCatalogEntry[]
): { family?: string; source?: BrowserFontSelection["source"] } {
  if (!selection) return {};
  if (selection.source === "system") return { family: selection.family, source: "system" };
  const family =
    selection.family ??
    catalog.find((font) => font.catalogId === selection.catalogId)?.family;
  return { ...(family ? { family } : {}), source: "google" };
}

function fontPreviewStyle(preview: ResolvedBrowserFontPreview): { fontFamily?: string } | undefined {
  return preview.fontFamily ? { fontFamily: preview.fontFamily } : undefined;
}

function browserFontSampleText(
  slot: BrowserFontSlot,
  cjkVariant: Exclude<BrowserFontCjkVariant, "auto">
): string {
  if (slot === "cjk") {
    return cjkVariant === "tc" ? "繁體" : cjkVariant === "sc" ? "简体" : "日本語";
  }
  if (slot === "numeric") return "0123";
  if (slot === "monospace") return "Aa 01";
  if (slot === "math") return "√x+1";
  return "Aa Rion";
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

function ReadOnlyValue({ value }: { value: string }): JSX.Element {
  return (
    <span className="glass-inset inline-flex h-[var(--control-height)] max-w-full items-center truncate rounded-sm px-2.5 text-control font-semibold leading-none text-foreground sm:max-w-[320px]">
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

function getSelectedBrowserGoogleFonts(
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

function browserFontSelectionLabel(
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

function parseBrowserFontSelectionValue(
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
    <div className="app-modal-backdrop app-no-drag fixed inset-0 z-[var(--layer-modal)] grid place-items-center p-5">
      <Surface
        className="flex max-h-[calc(100vh-2.5rem)] w-full max-w-[560px] flex-col overflow-hidden"
        radius="lg"
        variant="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="portable-export-title"
      >
        <div className="glass-divider border-b px-5 py-4">
          <h2 id="portable-export-title" className="text-heading font-semibold text-foreground">
            {t("settings.exportSelectionTitle")}
          </h2>
          <p className="mt-1 text-control text-muted-foreground">
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
          <p className="rounded-sm border border-border/40 bg-background/25 px-3 py-2 text-caption text-muted-foreground">
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
    <div className="app-modal-backdrop app-no-drag fixed inset-0 z-[var(--layer-modal)] grid place-items-center p-5">
      <Surface
        className="flex max-h-[calc(100vh-2.5rem)] w-full max-w-[560px] flex-col overflow-hidden"
        radius="lg"
        variant="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="portable-import-title"
      >
        <div className="glass-divider border-b px-5 py-4">
          <h2 id="portable-import-title" className="text-heading font-semibold text-foreground">
            {t("settings.importPreview")}
          </h2>
          <p className="mt-1 text-control text-muted-foreground">{t("settings.importPreviewDescription")}</p>
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
            <StatusCallout className="grid gap-3 px-3 py-3" tone="warning">
              <div>
                <p className="text-control font-semibold text-foreground">{t("settings.importConflictsTitle")}</p>
                <p className="text-caption text-muted-foreground">
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
                    <span className="text-control font-semibold text-foreground">
                      {conflict.name} · {conflict.roleNames.join(", ")}
                    </span>
                    <select
                      className="h-[var(--control-height)] rounded-sm border border-border/50 bg-background px-2 text-control text-foreground"
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
            </StatusCallout>
          ) : null}

          <div className="min-w-0 rounded-sm border border-border/40 bg-background/25 px-3 py-2">
            <p className="truncate text-caption font-medium text-muted-foreground">{preview.filePath}</p>
            <p className="mt-1 text-caption text-muted-foreground">
              {formatPortableSource(preview, t)}
            </p>
          </div>

          {selectedWarnings.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-control font-semibold text-foreground">
                {t("settings.importWarnings").replace("{count}", String(selectedWarnings.length))}
              </p>
              <ul className="app-scroll-region max-h-36 space-y-1 overflow-auto text-control text-muted-foreground">
                {selectedWarnings.map((warning, index) => (
                  <li key={`${warning.code}-${warning.itemName ?? index}`}>
                    {formatPortableWarning(warning, t)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-control text-muted-foreground">{t("settings.importNoWarnings")}</p>
          )}
          <p className="rounded-sm border border-border/40 bg-background/25 px-3 py-2 text-caption text-muted-foreground">
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
    <div className="grid gap-1.5 rounded-sm border border-border/40 bg-background/25 px-3 py-2">
      {items.filter((item) => item.selected).map((item) => {
        const summary = operations[item.key];
        return (
          <div key={item.key} className="flex items-center justify-between gap-3 text-caption">
            <span className="font-semibold text-foreground">{t(item.labelKey)}</span>
            <span className="text-right text-muted-foreground">
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
                <span className="block text-caption text-muted-foreground">
                  {isAvailable ? description : t("settings.portableUnavailable")}
                </span>
              </span>
              <span className="shrink-0 text-xs font-semibold text-muted-foreground">
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
