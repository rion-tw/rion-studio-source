import { ChevronDown, Download, FileJson, FileText, Laptop, Moon, RefreshCw, RotateCcw, Sun, Upload } from "lucide-react";
import { type JSX, type ReactNode, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { Button } from "../../components/ui/button";
import { useConfirmation } from "../../components/confirmation";
import { LegalDocumentDialog } from "../legal/LegalDocumentDialog";
import type { LegalDocumentKind } from "../legal/legalDocuments";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { PageFrame, SegmentedControl, Surface } from "../../components/ui/patterns";
import {
  languageLabelKeys,
  presetLabelKeys,
  resolvedThemeLabelKeys,
  themeLabelKeys,
  themeModes
} from "../../app/constants";
import {
  ROLE_WINDOW_CUSTOM_OPTION,
  createRoleWindowSizeValue,
  getRoleWindowSizeValue,
  isValidRoleWindowSize,
  parseRoleWindowSizeValue,
  roleWindowSizeOptions
} from "../../app/roleDefaults";
import type { ResolvedTheme, ThemeMode } from "../../app/types";
import { languages, type Language, type TranslationKey, type Translator } from "../../i18n";
import {
  DEFAULT_BROWSER_FONT_SETTINGS,
  browserFontFamilyRoles,
  normalizeBrowserProxyServer,
  normalizeGameBrowserSettings,
  workspaceGapSizes
} from "../../../../shared/browserFonts";
import { CURRENT_LEGAL_RELEASE, LEGAL_PROVIDER_NAME } from "../../../../shared/legal";
import type {
  AppUpdateStatus,
  BrowserCdnCompatibilityMode,
  BrowserFontFamilyRole,
  BrowserGraphicsMode,
  BrowserLaunchMode,
  GameBrowserSettings,
  GraphicsDiagnostics,
  LaunchPreset,
  PortableDataSelection,
  PortableExportInput,
  PortableExportResult,
  PortableImportInput,
  PortableImportOperations,
  PortableImportPreview,
  PortableImportResult,
  PortableImportWarning,
  PortableMacroConflictResolution,
  RoleDefaults,
  SystemFontFamily,
  WorkspaceAppearanceSettings,
  WorkspaceBackgroundStyle,
  WorkspaceGapSize
} from "../../../../shared/types";
import {
  applyGraphicsModeUpdate,
  getGraphicsRestartState
} from "./graphicsRestart";
import {
  clearPortableDataSelection,
  createDefaultPortableDataSelection,
  filterPortableImportWarnings,
  hasPortableDataSelection,
  isPortableGameSelectionRequired,
  isPortableRoleSelectionRequired,
  updatePortableDataSelection,
  type PortableDataAvailability,
  type PortableDataSection
} from "./portableSelection";
import { readSettingsSection, type SettingsSectionId } from "./settingsNavigation";

interface PortableDataCounts {
  gameCount: number;
  macroCount: number;
  roleCount: number;
  workspaceCount: number;
}

interface SettingsViewProps {
  gameBrowserSettings: GameBrowserSettings;
  hasRunningRoles: boolean;
  language: Language;
  portableDataCounts: PortableDataCounts;
  roleDefaults: RoleDefaults;
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
  onLoadGraphicsDiagnostics: () => Promise<GraphicsDiagnostics>;
  onLoadSystemFonts: () => Promise<SystemFontFamily[]>;
  onPreviewPortableImport: () => Promise<PortableImportPreview | null>;
  onApplyPortableImport: (input: PortableImportInput) => Promise<PortableImportResult>;
  onDiscardPortableImport: (importId: string) => Promise<void>;
  onOpenUpdateDownload: () => Promise<void>;
  onInstallDownloadedUpdate: () => Promise<void>;
  onRestartApplication: () => Promise<void>;
  onLanguageChange: (language: Language) => void;
  onRoleDefaultsChange: (roleDefaults: RoleDefaults) => void;
  onThemeModeChange: (themeMode: ThemeMode) => void;
  systemFonts: SystemFontFamily[];
}

interface SettingsViewBaseProps extends SettingsViewProps {
  activeSection: SettingsSectionId;
}

const settingsSectionTitleKeys: Record<SettingsSectionId, TranslationKey> = {
  aboutLegal: "settings.aboutLegal",
  data: "settings.data",
  game: "settings.game",
  interface: "settings.interface",
  updates: "settings.updates"
};

const settingsSectionDescriptionKeys: Record<SettingsSectionId, TranslationKey> = {
  aboutLegal: "settings.aboutLegalDescription",
  data: "settings.dataDescription",
  game: "settings.gameDescription",
  interface: "settings.interfaceDescription",
  updates: "settings.updatesDescription"
};

const browserFontRoleLabelKeys: Record<BrowserFontFamilyRole, TranslationKey> = {
  fixed: "settings.browserFonts.fixed",
  math: "settings.browserFonts.math",
  sansserif: "settings.browserFonts.sansSerif",
  serif: "settings.browserFonts.serif",
  standard: "settings.browserFonts.standard"
};

const graphicsModeDescriptionKeys: Record<BrowserGraphicsMode, TranslationKey> = {
  automatic: "settings.graphicsModeDescription.automatic",
  experimental: "settings.graphicsModeDescription.experimental",
  high_performance: "settings.graphicsModeDescription.highPerformance"
};

function SettingsViewBase({
  activeSection,
  gameBrowserSettings,
  hasRunningRoles,
  language,
  portableDataCounts,
  roleDefaults,
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
  onLoadGraphicsDiagnostics,
  onLoadSystemFonts,
  onPreviewPortableImport,
  onApplyPortableImport,
  onDiscardPortableImport,
  onOpenUpdateDownload,
  onInstallDownloadedUpdate,
  onRestartApplication,
  onLanguageChange,
  onRoleDefaultsChange,
  onThemeModeChange,
  systemFonts
}: SettingsViewBaseProps): JSX.Element {
  const confirm = useConfirmation();
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
  const [graphicsDiagnostics, setGraphicsDiagnostics] = useState<GraphicsDiagnostics | null>(null);
  const [isGraphicsBusy, setIsGraphicsBusy] = useState(false);
  const [isWorkspaceAppearanceSaving, setIsWorkspaceAppearanceSaving] = useState(false);
  const canCheckForUpdates = Boolean(updateStatus?.isPackaged) && !isUpdateBusy;
  const isManualUpdate = updateStatus?.installMode === "manual";
  const canInstallUpdate = updateStatus?.state === "downloaded";
  const canOpenUpdateDownload =
    isManualUpdate &&
    updateStatus?.state === "available" &&
    Boolean(updateStatus.downloadUrl ?? updateStatus.releasePageUrl);
  const pageTitle = t(settingsSectionTitleKeys[activeSection]);
  const pageDescription = t(settingsSectionDescriptionKeys[activeSection]);
  const portableExportAvailability = createPortableExportAvailability(portableDataCounts);

  function updateWorkspaceAppearanceSettings(update: Partial<WorkspaceAppearanceSettings>): void {
    if (isWorkspaceAppearanceSaving) {
      return;
    }

    const normalizedSettings = normalizeGameBrowserSettings(gameBrowserSettings);
    setIsWorkspaceAppearanceSaving(true);
    void onGameBrowserSettingsChange({
      ...normalizedSettings,
      workspace: {
        ...normalizedSettings.workspace,
        ...update
      }
    })
      .catch(onError)
      .finally(() => setIsWorkspaceAppearanceSaving(false));
  }

  async function refreshGraphicsDiagnostics(): Promise<GraphicsDiagnostics | null> {
    setIsGraphicsBusy(true);
    try {
      const diagnostics = await onLoadGraphicsDiagnostics();
      setGraphicsDiagnostics(diagnostics);
      return diagnostics;
    } catch (error) {
      onError(error);
      return null;
    } finally {
      setIsGraphicsBusy(false);
    }
  }

  useEffect(() => {
    if (activeSection !== "game") {
      return;
    }

    void refreshGraphicsDiagnostics();
    // The diagnostics callback is stable at the route boundary; refresh when the section opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection]);

  async function handleGraphicsModeChange(mode: BrowserGraphicsMode): Promise<void> {
    if (mode === "experimental") {
      const approved = await confirm({
        cancelLabel: t("confirm.cancel"),
        confirmLabel: t("settings.graphicsExperimentalConfirm"),
        description: t("settings.graphicsExperimentalWarning"),
        title: t("settings.graphicsExperimentalTitle"),
        tone: "destructive"
      });
      if (!approved) {
        return;
      }
    }

    setIsGraphicsBusy(true);
    try {
      const normalizedSettings = normalizeGameBrowserSettings(gameBrowserSettings);
      await applyGraphicsModeUpdate({
        save: async () => {
          await onGameBrowserSettingsChange({
            ...normalizedSettings,
            graphics: { mode }
          });
        },
        loadDiagnostics: onLoadGraphicsDiagnostics,
        onDiagnostics: setGraphicsDiagnostics,
        onRestartRequired: async () => {
          await showGraphicsRestartDialog(true);
        }
      });
    } catch (error) {
      onError(error);
    } finally {
      setIsGraphicsBusy(false);
    }
  }

  async function showGraphicsRestartDialog(restartRequired = Boolean(graphicsDiagnostics?.restartRequired)): Promise<void> {
    const restartState = getGraphicsRestartState(restartRequired, hasRunningRoles);
    if (restartState === "not_required") {
      return;
    }

    const approved = await confirm({
      cancelLabel: t("settings.graphicsRestartLater"),
      confirmLabel: t("settings.graphicsRestartNow"),
      confirmDisabled: restartState === "roles_running",
      description:
        restartState === "roles_running"
          ? t("settings.graphicsStopRolesBeforeRestart")
          : t("settings.graphicsRestartDescription"),
      title: t("settings.graphicsRestartTitle")
    });
    if (!approved) {
      return;
    }

    try {
      await onRestartApplication();
    } catch (error) {
      onError(error);
    }
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
          roleDefaults,
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
                showDivider={false}
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
          </>
        ) : null}

        {activeSection === "game" ? (
          <>
            <SettingsSection>
              <SettingsRow
                title={t("settings.defaultWindow")}
                description={t("settings.defaultWindowDescription")}
                control={
                  <DefaultWindowControl
                    roleDefaults={roleDefaults}
                    t={t}
                    onRoleDefaultsChange={onRoleDefaultsChange}
                  />
                }
              />
              <SettingsRow
                title={t("settings.defaultPreset")}
                description={t("settings.defaultPresetDescription")}
                control={
                  <Select
                    value={roleDefaults.launchPreset}
                    onValueChange={(value) =>
                      onRoleDefaultsChange({
                        ...roleDefaults,
                        launchPreset: value as LaunchPreset
                      })
                    }
                  >
                    <SelectTrigger className="settings-menu-control" aria-label={t("settings.defaultPreset")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="performance">{t(presetLabelKeys.performance)}</SelectItem>
                      <SelectItem value="balanced">{t(presetLabelKeys.balanced)}</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
            </SettingsSection>

            <SettingsSection title={t("settings.gameGroupBrowser")}>
              <SettingsRow
                title={t("settings.browserLaunchMode")}
                description={t("settings.browserLaunchModeDescription")}
                control={
                  <Select
                    value={normalizeGameBrowserSettings(gameBrowserSettings).launchMode}
                    onValueChange={(value) =>
                      void onGameBrowserSettingsChange(
                        normalizeGameBrowserSettings({
                          ...gameBrowserSettings,
                          launchMode: value as BrowserLaunchMode
                        })
                      ).catch(onError)
                    }
                  >
                    <SelectTrigger className="settings-menu-control" aria-label={t("settings.browserLaunchMode")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t("settings.browserLaunchModeAuto")}</SelectItem>
                      <SelectItem value="embedded">{t("settings.browserLaunchModeEmbedded")}</SelectItem>
                      <SelectItem value="external">{t("settings.browserLaunchModeExternal")}</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
              <BrowserFontsSettingsRows
                hasRunningRoles={hasRunningRoles}
                settings={gameBrowserSettings}
                systemFonts={systemFonts}
                t={t}
                onError={onError}
                onLoadSystemFonts={onLoadSystemFonts}
                onSave={onGameBrowserSettingsChange}
              />
            </SettingsSection>

            <SettingsSection title={t("settings.gameGroupGraphics")}>
              <SettingsRow
                title={t("settings.graphicsMode")}
                description={t(graphicsModeDescriptionKeys[normalizeGameBrowserSettings(gameBrowserSettings).graphics.mode])}
                control={
                  <div className="flex max-w-[420px] flex-wrap items-center justify-end gap-2">
                    <Select
                      disabled={isGraphicsBusy}
                      value={normalizeGameBrowserSettings(gameBrowserSettings).graphics.mode}
                      onValueChange={(value) => void handleGraphicsModeChange(value as BrowserGraphicsMode)}
                    >
                      <SelectTrigger className="settings-menu-control" aria-label={t("settings.graphicsMode")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="automatic">{t("settings.graphicsModeAutomatic")}</SelectItem>
                        <SelectItem value="high_performance">
                          {t("settings.graphicsModeHighPerformance")}
                        </SelectItem>
                        <SelectItem value="experimental">{t("settings.graphicsModeExperimental")}</SelectItem>
                      </SelectContent>
                    </Select>
                    {graphicsDiagnostics?.restartRequired ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void showGraphicsRestartDialog(true)}
                      >
                        <RotateCcw size={14} />
                        {t("settings.graphicsRestartPending")}
                      </Button>
                    ) : null}
                  </div>
                }
              />
              <SettingsRow
                title={t("settings.graphicsHardwareAcceleration")}
                description={formatGraphicsRuntimeSummary(graphicsDiagnostics, t)}
                control={
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isGraphicsBusy}
                    onClick={() => void refreshGraphicsDiagnostics()}
                  >
                    <RefreshCw size={14} className={isGraphicsBusy ? "animate-spin" : undefined} />
                    {t("settings.graphicsRefresh")}
                  </Button>
                }
              />
              <SettingsRow
                title={t("settings.graphicsDevice")}
                description={formatGraphicsDeviceSummary(graphicsDiagnostics, t)}
                control={<MetadataValue value={formatGraphicsApiSummary(graphicsDiagnostics, t)} />}
              />
              <SettingsRow
                title={t("settings.graphicsFeatureStatus")}
                description={formatGraphicsFeatureSummary(graphicsDiagnostics, t)}
                control={<MetadataValue value={formatGraphicsVersionSummary(graphicsDiagnostics)} />}
              />
              {graphicsDiagnostics?.externalRoles.length ? (
                <SettingsRow
                  title={t("settings.graphicsExternalSessions")}
                  description={formatExternalGraphicsSummary(graphicsDiagnostics, t)}
                  control={<ReadOnlyValue value={String(graphicsDiagnostics.externalRoles.length)} />}
                />
              ) : null}
            </SettingsSection>

            <SettingsSection title={t("settings.gameGroupNetwork")}>
              <BrowserProxySettingsRow
                hasRunningRoles={hasRunningRoles}
                settings={gameBrowserSettings}
                t={t}
                onError={onError}
                onSave={onGameBrowserSettingsChange}
              />
              <SettingsRow
                title={t("settings.cdnCompatibility")}
                description={
                  hasRunningRoles
                    ? t("settings.cdnCompatibilityRestartNotice")
                    : t("settings.cdnCompatibilityDescription")
                }
                control={
                  <Select
                    value={normalizeGameBrowserSettings(gameBrowserSettings).network.cdnCompatibility.mode}
                    onValueChange={(value) => {
                      const normalizedSettings = normalizeGameBrowserSettings(gameBrowserSettings);
                      void onGameBrowserSettingsChange(
                        normalizeGameBrowserSettings({
                          ...normalizedSettings,
                          network: {
                            ...normalizedSettings.network,
                            cdnCompatibility: {
                              mode: value as BrowserCdnCompatibilityMode
                            }
                          }
                        })
                      ).catch(onError);
                    }}
                  >
                    <SelectTrigger className="settings-menu-control" aria-label={t("settings.cdnCompatibility")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t("settings.cdnCompatibilityAuto")}</SelectItem>
                      <SelectItem value="on">{t("settings.cdnCompatibilityOn")}</SelectItem>
                      <SelectItem value="off">{t("settings.cdnCompatibilityOff")}</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
            </SettingsSection>
          </>
        ) : null}

        {activeSection === "data" ? (
          <SettingsSection>
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

interface DefaultWindowControlProps {
  roleDefaults: RoleDefaults;
  t: Translator;
  onRoleDefaultsChange: (roleDefaults: RoleDefaults) => void;
}

function DefaultWindowControl({
  roleDefaults,
  t,
  onRoleDefaultsChange
}: DefaultWindowControlProps): JSX.Element {
  const { windowHeight, windowWidth } = roleDefaults;
  const derivedWindowSizeValue = getRoleWindowSizeValue(roleDefaults);
  const [selectedWindowSize, setSelectedWindowSize] = useState(derivedWindowSizeValue);
  const [customWidth, setCustomWidth] = useState(String(windowWidth));
  const [customHeight, setCustomHeight] = useState(String(windowHeight));
  const isCustomWindowSize = selectedWindowSize === ROLE_WINDOW_CUSTOM_OPTION;

  useEffect(() => {
    const nextWindowSizeValue = getRoleWindowSizeValue({ windowHeight, windowWidth });
    setSelectedWindowSize(nextWindowSizeValue);
    setCustomWidth(String(windowWidth));
    setCustomHeight(String(windowHeight));
  }, [windowHeight, windowWidth]);

  function handleWindowSizeChange(value: string): void {
    setSelectedWindowSize(value);

    if (value === ROLE_WINDOW_CUSTOM_OPTION) {
      setCustomWidth(String(windowWidth));
      setCustomHeight(String(windowHeight));
      return;
    }

    const parsedSize = parseRoleWindowSizeValue(value);
    if (!parsedSize) {
      return;
    }

    onRoleDefaultsChange({
      ...roleDefaults,
      ...parsedSize
    });
  }

  function handleCustomSizeChange(field: "windowHeight" | "windowWidth", value: string): void {
    if (field === "windowWidth") {
      setCustomWidth(value);
    } else {
      setCustomHeight(value);
    }

    const nextSize = Number(value);
    if (!value.trim() || !isValidRoleWindowSize(nextSize)) {
      return;
    }

    onRoleDefaultsChange({
      ...roleDefaults,
      [field]: nextSize
    });
  }

  function resetCustomSize(field: "windowHeight" | "windowWidth"): void {
    if (field === "windowWidth") {
      setCustomWidth(String(windowWidth));
    } else {
      setCustomHeight(String(windowHeight));
    }
  }

  return (
    <div className="settings-menu-stack grid gap-2">
      <Select
        value={selectedWindowSize}
        onValueChange={handleWindowSizeChange}
      >
        <SelectTrigger className="settings-menu-control" aria-label={t("settings.defaultWindow")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {roleWindowSizeOptions.map((option) => (
            <SelectItem
              key={createRoleWindowSizeValue(option.width, option.height)}
              value={createRoleWindowSizeValue(option.width, option.height)}
            >
              {formatRoleWindowSize(option.width, option.height)}
            </SelectItem>
          ))}
          <SelectItem value={ROLE_WINDOW_CUSTOM_OPTION}>{t("settings.defaultWindow.custom")}</SelectItem>
        </SelectContent>
      </Select>

      {isCustomWindowSize ? (
        <div className="settings-window-size-fields grid grid-cols-2 gap-2">
          <Input
            aria-label={t("settings.defaultWindowWidth")}
            inputMode="numeric"
            max={7680}
            min={640}
            type="number"
            value={customWidth}
            onBlur={() => resetCustomSize("windowWidth")}
            onChange={(event) => handleCustomSizeChange("windowWidth", event.target.value)}
          />
          <Input
            aria-label={t("settings.defaultWindowHeight")}
            inputMode="numeric"
            max={7680}
            min={640}
            type="number"
            value={customHeight}
            onBlur={() => resetCustomSize("windowHeight")}
            onChange={(event) => handleCustomSizeChange("windowHeight", event.target.value)}
          />
        </div>
      ) : null}
    </div>
  );
}

interface BrowserFontsSettingsRowsProps {
  hasRunningRoles: boolean;
  settings: GameBrowserSettings;
  systemFonts: SystemFontFamily[];
  t: Translator;
  onError: (error: unknown) => void;
  onLoadSystemFonts: () => Promise<SystemFontFamily[]>;
  onSave: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>;
}

function BrowserFontsSettingsRows({
  hasRunningRoles,
  settings,
  systemFonts,
  t,
  onError,
  onLoadSystemFonts,
  onSave
}: BrowserFontsSettingsRowsProps): JSX.Element {
  const [draft, setDraft] = useState<GameBrowserSettings>(() => normalizeGameBrowserSettings(settings));
  const [availableFonts, setAvailableFonts] = useState<SystemFontFamily[]>(systemFonts);
  const [isLoadingFonts, setIsLoadingFonts] = useState(systemFonts.length === 0);
  const [isSaving, setIsSaving] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fontOptions = getBrowserFontOptions(availableFonts, draft);
  const isDirty = JSON.stringify(normalizeGameBrowserSettings(draft)) !== JSON.stringify(normalizeGameBrowserSettings(settings));

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

  function handleFontFamilyChange(role: BrowserFontFamilyRole, value: string): void {
    setMessage(null);
    setDraft((current) =>
      normalizeGameBrowserSettings({
        ...current,
        fonts: {
          families: {
            ...current.fonts.families,
            [role]: value
          },
          mode: "custom"
        }
      })
    );
  }

  async function saveSettings(settingsToSave: GameBrowserSettings): Promise<void> {
    setIsSaving(true);

    try {
      const savedSettings = await onSave(settingsToSave);
      setDraft(normalizeGameBrowserSettings(savedSettings));
      setMessage(hasRunningRoles ? t("settings.browserFontsRestartNotice") : t("settings.browserFontsSaved"));
    } catch (error) {
      onError(error);
    } finally {
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
          <div className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {browserFontFamilyRoles.map((role) => (
                <BrowserFontFamilyInput
                  key={role}
                  disabled={isSaving}
                  fontOptions={fontOptions}
                  label={t(browserFontRoleLabelKeys[role])}
                  role={role}
                  value={draft.fonts.families[role] ?? ""}
                  onValueChange={handleFontFamilyChange}
                />
              ))}
            </div>

            <BrowserFontsPreview settings={draft} t={t} />
            {isLoadingFonts ? (
              <p className="text-xs leading-5 text-muted-foreground">{t("settings.browserFontsLoading")}</p>
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
                      fonts: DEFAULT_BROWSER_FONT_SETTINGS
                    })
                  )
                }
              >
                <RotateCcw size={14} />
                {t("settings.browserFontsReset")}
              </Button>
              <Button type="button" disabled={isSaving || !isDirty} onClick={() => void saveSettings(draft)}>
                {t("settings.browserFontsSave")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

interface BrowserProxySettingsRowProps {
  hasRunningRoles: boolean;
  settings: GameBrowserSettings;
  t: Translator;
  onError: (error: unknown) => void;
  onSave: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>;
}

function BrowserProxySettingsRow({
  hasRunningRoles,
  settings,
  t,
  onError,
  onSave
}: BrowserProxySettingsRowProps): JSX.Element {
  const normalizedSettings = normalizeGameBrowserSettings(settings);
  const [draft, setDraft] = useState(normalizedSettings.network.proxy.server);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const normalizedServer = normalizeBrowserProxyServer(draft);
  const isEmpty = draft.trim() === "";
  const isValid = isEmpty || Boolean(normalizedServer);
  const currentServer = normalizedSettings.network.proxy.server;
  const isDirty = (isEmpty ? "" : normalizedServer) !== currentServer;

  useEffect(() => {
    setDraft(normalizeGameBrowserSettings(settings).network.proxy.server);
  }, [settings]);

  async function saveProxySettings(): Promise<void> {
    if (!isDirty || !isValid || isSaving) {
      return;
    }

    setIsSaving(true);
    setMessage(null);

    try {
      const savedSettings = await onSave(
        normalizeGameBrowserSettings({
          ...normalizedSettings,
          network: {
            ...normalizedSettings.network,
            proxy: isEmpty
              ? { mode: "system", server: "" }
              : {
                  mode: "custom",
                  server: normalizedServer
                }
          }
        })
      );
      setDraft(savedSettings.network.proxy.server);
      setMessage(hasRunningRoles ? t("settings.browserProxyRestartNotice") : t("settings.browserProxySaved"));
    } catch (error) {
      onError(error);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <SettingsRow
      title={t("settings.browserProxy")}
      description={`${
        message ??
        (!isValid ? t("settings.browserProxyInvalid") : formatBrowserProxySettingsSummary(normalizedSettings, t))
      } ${t("settings.browserProxyPrivacy")}`}
      control={
        <Input
          className="sm:w-[420px]"
          disabled={isSaving}
          placeholder={t("settings.browserProxyServerPlaceholder")}
          value={draft}
          onBlur={() => void saveProxySettings()}
          onChange={(event) => {
            setMessage(null);
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
      }
    />
  );
}

interface BrowserFontFamilyInputProps {
  disabled: boolean;
  fontOptions: SystemFontFamily[];
  label: string;
  role: BrowserFontFamilyRole;
  value: string;
  onValueChange: (role: BrowserFontFamilyRole, value: string) => void;
}

function BrowserFontFamilyInput({
  disabled,
  fontOptions,
  label,
  role,
  value,
  onValueChange
}: BrowserFontFamilyInputProps): JSX.Element {
  const listId = `browser-font-${role}-options`;

  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-semibold leading-5 text-foreground">{label}</span>
      <Input
        list={listId}
        disabled={disabled}
        placeholder={label}
        value={value}
        onChange={(event) => onValueChange(role, event.target.value)}
      />
      <datalist id={listId}>
        {fontOptions.map((font) => (
          <option key={`${role}-${font.family}`} value={font.family}>
            {font.label}
          </option>
        ))}
      </datalist>
    </label>
  );
}

function BrowserFontsPreview({ settings, t }: { settings: GameBrowserSettings; t: Translator }): JSX.Element {
  const families = settings.fonts.families;
  const standardFamily = families.standard || families.sansserif || families.serif || undefined;
  const fixedFamily = families.fixed || undefined;
  const mathFamily = families.math || standardFamily;

  return (
    <div className="grid gap-2 rounded-md border border-border/25 px-3 py-3 text-xs leading-5 text-muted-foreground">
      <p style={{ fontFamily: standardFamily }}>{t("settings.browserFontsPreviewText")}</p>
      <p style={{ fontFamily: fixedFamily }}>0123456789 ABC abc</p>
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
  description: string;
  showDivider?: boolean;
  title: string;
}

function SettingsRow({ control, description, showDivider = true, title }: SettingsRowProps): JSX.Element {
  const dividerClassName = showDivider ? "glass-divider border-b last:border-b-0" : "";

  return (
    <div
      className={`settings-row flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${dividerClassName}`}
    >
      <div className="min-w-0">
        <p className="text-[13px] font-semibold leading-5 text-foreground">{title}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
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

function MetadataValue({ value }: { value: string }): JSX.Element {
  return (
    <span className="block max-w-full truncate text-right text-[12px] leading-5 text-muted-foreground sm:max-w-[320px]">
      {value}
    </span>
  );
}

function formatGraphicsRuntimeSummary(diagnostics: GraphicsDiagnostics | null, t: Translator): string {
  if (!diagnostics) {
    return t("settings.graphicsLoading");
  }

  return [
    diagnostics.hardwareAccelerationEnabled === null
      ? t("settings.graphicsUnknown")
      : t(diagnostics.hardwareAccelerationEnabled ? "settings.graphicsEnabled" : "settings.graphicsDisabled"),
    t(diagnostics.gpuInfoReady ? "settings.graphicsGpuInfoReady" : "settings.graphicsGpuInfoPending"),
    `${t("settings.graphicsMode")}: ${formatGraphicsMode(diagnostics.appliedMode, t)}`
  ].join(" · ");
}

function formatGraphicsDeviceSummary(diagnostics: GraphicsDiagnostics | null, t: Translator): string {
  if (!diagnostics) {
    return t("settings.graphicsLoading");
  }

  const device = diagnostics.gpuDevice;
  if (!device) {
    return t("settings.graphicsNoDevice");
  }

  const name = device.deviceString || device.vendorString || formatDeviceId(device.vendorId, device.deviceId);
  const driver = [device.driverVendor, device.driverVersion].filter(Boolean).join(" ");
  const renderer = diagnostics.embedded.renderer;
  return [name, driver, renderer].filter(Boolean).join(" · ");
}

function formatGraphicsApiSummary(diagnostics: GraphicsDiagnostics | null, t: Translator): string {
  if (!diagnostics) {
    return "WebGL · WebGL2 · WebGPU";
  }

  return [
    `WebGL ${formatAvailability(diagnostics.embedded.webgl, t)}`,
    `WebGL2 ${formatAvailability(diagnostics.embedded.webgl2, t)}`,
    `WebGPU ${formatAvailability(diagnostics.embedded.webgpu, t)}`
  ].join(" · ");
}

function formatGraphicsFeatureSummary(diagnostics: GraphicsDiagnostics | null, t: Translator): string {
  if (!diagnostics) {
    return t("settings.graphicsLoading");
  }

  const features = ["gpu_compositing", "rasterization", "webgl", "webgl2"]
    .map((name) => diagnostics.featureStatus[name] ? `${name}: ${diagnostics.featureStatus[name]}` : "")
    .filter(Boolean);
  return features.length > 0 ? features.join(" · ") : t("settings.graphicsNoFeatureStatus");
}

function formatGraphicsVersionSummary(diagnostics: GraphicsDiagnostics | null): string {
  return diagnostics
    ? `Electron ${diagnostics.versions.electron} · Chromium ${diagnostics.versions.chromium}`
    : "Electron · Chromium";
}

function formatExternalGraphicsSummary(diagnostics: GraphicsDiagnostics, t: Translator): string {
  return diagnostics.externalRoles
    .map((role) => {
      if (!role.probe) {
        return `${role.roleName}: ${t("settings.graphicsUnavailable")}`;
      }
      return `${role.roleName}: WebGL2 ${formatAvailability(role.probe.webgl2, t)}, WebGPU ${formatAvailability(role.probe.webgpu, t)}`;
    })
    .join(" · ");
}

function formatGraphicsMode(mode: BrowserGraphicsMode, t: Translator): string {
  if (mode === "high_performance") return t("settings.graphicsModeHighPerformance");
  if (mode === "experimental") return t("settings.graphicsModeExperimental");
  return t("settings.graphicsModeAutomatic");
}

function formatAvailability(
  availability: "available" | "unavailable" | "unknown",
  t: Translator
): string {
  if (availability === "available") return t("settings.graphicsAvailable");
  if (availability === "unavailable") return t("settings.graphicsUnavailable");
  return t("settings.graphicsUnknown");
}

function formatDeviceId(vendorId?: number, deviceId?: number): string {
  if (vendorId === undefined && deviceId === undefined) {
    return "GPU";
  }

  return [vendorId, deviceId]
    .filter((value): value is number => value !== undefined)
    .map((value) => `0x${value.toString(16).padStart(4, "0")}`)
    .join(":");
}

function formatRoleWindowSize(width: number, height: number): string {
  return `${width} x ${height}`;
}

function formatBrowserFontSettingsSummary(settings: GameBrowserSettings, t: Translator): string {
  if (settings.fonts.mode === "default") {
    return t("settings.browserFontsDefault");
  }

  const selectedFamilies = browserFontFamilyRoles.map((role) => settings.fonts.families[role]).filter(Boolean);
  return selectedFamilies.length > 0
    ? selectedFamilies.join(" / ")
    : t("settings.browserFontsCustomEmpty");
}

function formatBrowserProxySettingsSummary(settings: GameBrowserSettings, t: Translator): string {
  const proxy = normalizeGameBrowserSettings(settings).network.proxy;
  if (proxy.mode !== "custom") {
    return t("settings.browserProxySystem");
  }

  return `${t("settings.browserProxyCustom")}: ${proxy.server}`;
}

function getBrowserFontOptions(
  systemFonts: SystemFontFamily[],
  settings: GameBrowserSettings
): SystemFontFamily[] {
  const selectedFonts = browserFontFamilyRoles
    .map((role) => settings.fonts.families[role])
    .filter((fontFamily): fontFamily is string => Boolean(fontFamily));
  const fontsByKey = new Map<string, SystemFontFamily>();

  for (const font of [...systemFonts, ...selectedFonts.map((family) => ({ family, label: family }))]) {
    const key = font.family.toLocaleLowerCase();
    if (!fontsByKey.has(key)) {
      fontsByKey.set(key, font);
    }
  }

  return [...fontsByKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function createPortableExportAvailability(counts: PortableDataCounts): PortableDataAvailability {
  return {
    games: counts.gameCount > 0,
    roles: counts.roleCount > 0,
    launchWorkspaces: counts.workspaceCount > 0,
    macros: counts.macroCount > 0,
    preferences: true
  };
}

function createPortableImportAvailability(preview: PortableImportPreview): PortableDataAvailability {
  return {
    games: preview.gameCount > 0,
    roles: preview.roleCount > 0,
    launchWorkspaces: preview.workspaceCount > 0,
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
          const itemDisabled = disabled || !isAvailable || isRoleLocked || isGameLocked;
          const description = isRoleLocked
            ? t("settings.portableRolesRequired")
            : isGameLocked
              ? t("settings.portableGamesRequired")
              : t(descriptionKey);

          return (
            <label
              key={section}
              className={`glass-inset flex min-h-14 items-center gap-3 rounded-md px-3 py-2.5 ${
                itemDisabled ? "opacity-60" : "cursor-pointer"
              }`}
            >
              <input
                className="size-4 shrink-0 accent-primary"
                type="checkbox"
                checked={selection[section]}
                disabled={itemDisabled}
                onChange={(event) =>
                  onChange(
                    updatePortableDataSelection(selection, section, event.target.checked, availability)
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
    case "WORKSPACE_NAME_RENAMED":
      return t("settings.warningWorkspaceRenamed").replace("{name}", itemName).replace("{next}", replacementName);
    case "WORKSPACE_ROLE_MISSING":
      return t("settings.warningWorkspaceRoleMissing").replace("{name}", itemName).replace("{count}", count);
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
