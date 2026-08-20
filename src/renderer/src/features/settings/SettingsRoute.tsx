import { Download, FileJson, FileText, Laptop, Moon, RefreshCw, RotateCcw, Sun, Upload } from "lucide-react";

import { type JSX, useState } from "react";

import { useSearchParams } from "react-router";

import { Button } from "../../components/ui/button";

import { LegalDocumentDialog } from "../legal/LegalDocumentDialog";

import type { LegalDocumentKind } from "../legal/legalDocuments";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";

import { Switch } from "../../components/ui/switch";

import { PageFrame, SegmentedControl, SettingsRow, SettingsSection } from "../../components/ui/patterns";

import { languageLabelKeys, resolvedThemeLabelKeys, themeLabelKeys, themeModes } from "../../app/constants";

import type { ResolvedTheme, ThemeMode } from "../../app/types";

import { languages, type Language, type Translator } from "../../i18n";

import { normalizeGameBrowserSettings, workspaceGapSizes } from "../../../../shared/browserFonts";

import { getLegalDocumentVersion, LEGAL_PROVIDER_NAME } from "../../../../shared/legal";

import type { AppUpdateStatus, BrowserPerformanceSettings, GameBrowserSettings, GameBrowserSettingsPatch, Game, MacosHighRefreshMode, MacroSettings, PortableDataSelection, PortableExportInput, PortableExportResult, PortableImportInput, PortableImportPreview, PortableImportResult, PortableMacroConflictResolution, QuickAccessPreferences, RuntimeWindowPreferences, Role, SystemFontFamily, WorkspaceAppearanceSettings, WorkspaceBackgroundStyle, WorkspaceGapSize } from "../../../../shared/types";

import { MacroSettingsSection } from "./MacroSettingsSection";

import { DiagnosticsSettingsSection } from "./DiagnosticsSettingsSection";

import { ChromeProfileImportFlow } from "./ChromeProfileImportFlow";

import { clearPortableDataSelection, createDefaultPortableDataSelection, hasPortableDataSelection } from "./portableSelection";

import { readSettingsSection, type SettingsSectionId } from "./settingsNavigation";

import { settingsSectionDescriptionKeys, settingsSectionTitleKeys } from "./settingsPresentation";

import { MacroOverlaySettingsRows, ReadOnlyValue, createPortableExportAvailability, createPortableImportAvailability } from "./MacroBadgePositionSettingsRows";

import { PortableExportDialog, PortableImportDialog, formatPortableExportResult, formatPortableImportResult, formatUpdateStatus } from "./PortableSettingsDialogs";

import { BrowserFontsSettingsRows } from "./BrowserFontsSettingsRows";

export interface PortableDataCounts {
  gameCount: number;
  gameWindowCount: number;
  macroCount: number;
  roleCount: number;
  workspaceCount: number;
}

interface SettingsViewProps {
  games?: Game[];
  gameBrowserSettings: GameBrowserSettings;
  roles?: Role[];
  language: Language;
  macroSettings: MacroSettings;
  quickAccessPreferences?: QuickAccessPreferences;
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
  onClearQuickAccessRecent?: () => Promise<void>;
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

function SettingsViewBase({
  activeSection,
  games = [],
  gameBrowserSettings,
  roles = [],
  language,
  macroSettings,
  quickAccessPreferences = { pinnedItems: [], recentItems: [] },
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
  onClearQuickAccessRecent = async () => undefined,
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
  const [isQuickAccessClearing, setIsQuickAccessClearing] = useState(false);
  const isMacOS = document.documentElement.dataset.platform === "mac";
  const canCheckForUpdates =
    Boolean(updateStatus?.isPackaged) &&
    !isUpdateBusy &&
    updateStatus?.state !== "downloaded" &&
    !(updateStatus?.state === "install_failed" && updateStatus.canRetryInstall === true);
  const isManualUpdate = updateStatus?.installMode === "manual";
  const canInstallUpdate = updateStatus?.state === "downloaded" ||
    (updateStatus?.state === "install_failed" && updateStatus.canRetryInstall === true);
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
      ...(patch.macroOverlay ? {
        macroOverlay: { ...normalizedSettings.macroOverlay, ...patch.macroOverlay }
      } : {}),
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

  function updateBrowserPerformanceSettings(
    update: Partial<BrowserPerformanceSettings>
  ): void {
    if (isBrowserPerformanceSaving) {
      return;
    }

    const normalizedSettings = normalizeGameBrowserSettings(gameBrowserSettings);
    setIsBrowserPerformanceSaving(true);
    void saveNonFontPatch({
      performance: {
        ...normalizedSettings.performance,
        ...update
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
        {activeSection === "preferences" ? (
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
                    <Select
                      value={normalizeGameBrowserSettings(gameBrowserSettings).performance.macosHighRefreshMode}
                      disabled={isBrowserPerformanceSaving}
                      onValueChange={(macosHighRefreshMode) =>
                        updateBrowserPerformanceSettings({
                          macosHighRefreshMode: macosHighRefreshMode as MacosHighRefreshMode
                        })}
                    >
                      <SelectTrigger
                        className="settings-menu-control"
                        aria-label={t("settings.macosHighRefreshRate")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">{t("settings.macosHighRefreshRate.auto")}</SelectItem>
                        <SelectItem value="enabled">{t("settings.macosHighRefreshRate.enabled")}</SelectItem>
                        <SelectItem value="disabled">{t("settings.macosHighRefreshRate.disabled")}</SelectItem>
                      </SelectContent>
                    </Select>
                  }
                />
              ) : null}
            </SettingsSection>
          </>
        ) : null}

        {activeSection === "interface" ? (
          <>
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
          </>
        ) : null}

        {activeSection === "preferences" ? (
          <>
            <SettingsSection title={t("settings.quickAccess")}>
              <SettingsRow
                title={t("settings.quickAccessShortcut")}
                description={t("settings.quickAccessShortcutDescription")}
                control={<ReadOnlyValue value={isMacOS ? "⌘K" : "Ctrl+K"} />}
              />
              <SettingsRow
                showDivider={false}
                title={t("settings.quickAccessRecent")}
                description={t("settings.quickAccessRecentDescription").replace(
                  "{count}",
                  String(quickAccessPreferences.recentItems.length)
                )}
                control={
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isQuickAccessClearing || quickAccessPreferences.recentItems.length === 0}
                    onClick={() => {
                      setIsQuickAccessClearing(true);
                      void onClearQuickAccessRecent()
                        .catch(onError)
                        .finally(() => setIsQuickAccessClearing(false));
                    }}
                  >
                    {t("settings.quickAccessClearRecent")}
                  </Button>
                }
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
          </>
        ) : null}

        {activeSection === "interface" ? (
          <>
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

            <SettingsSection title={t("settings.macroOverlay")}>
              <MacroOverlaySettingsRows
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

function SettingsView(props: SettingsViewProps): JSX.Element {
  const [searchParams] = useSearchParams();
  const activeSection = readSettingsSection(searchParams.get("section"));

  return <SettingsViewBase {...props} activeSection={activeSection} />;
}

export default SettingsView;
