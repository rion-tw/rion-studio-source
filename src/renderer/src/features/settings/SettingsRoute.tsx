import { ChevronDown, Download, FileJson, Laptop, Moon, RefreshCw, RotateCcw, Sun, Type as TypeIcon, Upload } from "lucide-react";
import { type JSX, type ReactNode, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
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
  browserFontFamilyRoles,
  DEFAULT_GAME_BROWSER_SETTINGS,
  normalizeGameBrowserSettings
} from "../../../../shared/browserFonts";
import type {
  AppUpdateStatus,
  BrowserFontFamilyRole,
  BrowserFontSettingsMode,
  GameBrowserSettings,
  LaunchPreset,
  PortableExportInput,
  PortableExportResult,
  PortableImportPreview,
  PortableImportResult,
  PortableImportWarning,
  RoleDefaults,
  SystemFontFamily
} from "../../../../shared/types";
import { readSettingsSection, type SettingsSectionId } from "./settingsNavigation";

interface SettingsViewProps {
  gameBrowserSettings: GameBrowserSettings;
  hasRunningRoles: boolean;
  language: Language;
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
  onLoadSystemFonts: () => Promise<SystemFontFamily[]>;
  onPreviewPortableImport: () => Promise<PortableImportPreview | null>;
  onApplyPortableImport: (importId: string) => Promise<PortableImportResult>;
  onOpenUpdateDownload: () => Promise<void>;
  onInstallDownloadedUpdate: () => Promise<void>;
  onLanguageChange: (language: Language) => void;
  onRoleDefaultsChange: (roleDefaults: RoleDefaults) => void;
  onThemeModeChange: (themeMode: ThemeMode) => void;
  systemFonts: SystemFontFamily[];
}

interface SettingsViewBaseProps extends SettingsViewProps {
  activeSection: SettingsSectionId;
}

const settingsSectionTitleKeys: Record<SettingsSectionId, TranslationKey> = {
  data: "settings.data",
  game: "settings.game",
  interface: "settings.interface",
  updates: "settings.updates"
};

const settingsSectionDescriptionKeys: Record<SettingsSectionId, TranslationKey> = {
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

function SettingsViewBase({
  activeSection,
  gameBrowserSettings,
  hasRunningRoles,
  language,
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
  onLoadSystemFonts,
  onPreviewPortableImport,
  onApplyPortableImport,
  onOpenUpdateDownload,
  onInstallDownloadedUpdate,
  onLanguageChange,
  onRoleDefaultsChange,
  onThemeModeChange,
  systemFonts
}: SettingsViewBaseProps): JSX.Element {
  const [portableImportPreview, setPortableImportPreview] = useState<PortableImportPreview | null>(null);
  const [portableMessage, setPortableMessage] = useState<string | null>(null);
  const [isPortableBusy, setIsPortableBusy] = useState(false);
  const canCheckForUpdates = Boolean(updateStatus?.isPackaged) && !isUpdateBusy;
  const isManualUpdate = updateStatus?.installMode === "manual";
  const canInstallUpdate = updateStatus?.state === "downloaded";
  const canOpenUpdateDownload =
    isManualUpdate &&
    updateStatus?.state === "available" &&
    Boolean(updateStatus.downloadUrl ?? updateStatus.releasePageUrl);
  const pageTitle = t(settingsSectionTitleKeys[activeSection]);
  const pageDescription = t(settingsSectionDescriptionKeys[activeSection]);

  async function handleExportPortableData(): Promise<void> {
    setIsPortableBusy(true);
    setPortableMessage(null);

    try {
      const result = await onExportPortableData({
        preferences: {
          language,
          gameBrowserSettings,
          roleDefaults,
          themeMode
        }
      });

      if (result) {
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
      const result = await onApplyPortableImport(portableImportPreview.importId);
      setPortableImportPreview(null);
      setPortableMessage(formatPortableImportResult(result, t));
    } catch (error) {
      onError(error);
    } finally {
      setIsPortableBusy(false);
    }
  }

  return (
    <PageFrame
      maxWidth="settings"
      className="settings-page"
      contentClassName="mx-auto flex min-h-full w-full max-w-[840px] flex-col gap-8"
    >
      <header className="settings-page-header">
        <h1 className="text-[26px] font-semibold leading-tight text-foreground">{pageTitle}</h1>
        <p className="mt-2 max-w-2xl text-[13px] leading-5 text-muted-foreground">{pageDescription}</p>
      </header>

      <div className="grid gap-8">
        {activeSection === "interface" ? (
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
                  className="settings-menu-control"
                  value={language}
                  onChange={(event) => onLanguageChange(event.target.value as Language)}
                >
                  {languages.map((option) => (
                    <option key={option} value={option}>
                      {t(languageLabelKeys[option])}
                    </option>
                  ))}
                </Select>
              }
            />
          </SettingsSection>
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
                    className="settings-menu-control"
                    value={roleDefaults.launchPreset}
                    onChange={(event) =>
                      onRoleDefaultsChange({
                        ...roleDefaults,
                        launchPreset: event.target.value as LaunchPreset
                      })
                    }
                  >
                    <option value="performance">{t(presetLabelKeys.performance)}</option>
                    <option value="balanced">{t(presetLabelKeys.balanced)}</option>
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
                  onClick={() => void handleExportPortableData()}
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
      </div>

      {portableImportPreview ? (
        <PortableImportDialog
          isBusy={isPortableBusy}
          preview={portableImportPreview}
          t={t}
          onCancel={() => setPortableImportPreview(null)}
          onConfirm={() => void handleApplyPortableImport()}
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
        className="settings-menu-control"
        value={selectedWindowSize}
        onChange={(event) => handleWindowSizeChange(event.target.value)}
      >
        {roleWindowSizeOptions.map((option) => (
          <option
            key={createRoleWindowSizeValue(option.width, option.height)}
            value={createRoleWindowSizeValue(option.width, option.height)}
          >
            {formatRoleWindowSize(option.width, option.height)}
          </option>
        ))}
        <option value={ROLE_WINDOW_CUSTOM_OPTION}>{t("settings.defaultWindow.custom")}</option>
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
  const isCustom = draft.fonts.mode === "custom";
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

  function handleModeChange(mode: BrowserFontSettingsMode): void {
    setMessage(null);
    setDraft((current) =>
      normalizeGameBrowserSettings({
        fonts: {
          families: mode === "custom" ? current.fonts.families : {},
          mode
        }
      })
    );
  }

  function handleFontFamilyChange(role: BrowserFontFamilyRole, value: string): void {
    setMessage(null);
    setDraft((current) =>
      normalizeGameBrowserSettings({
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
        control={
          <Button
            type="button"
            variant="outline"
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded((current) => !current)}
          >
            <TypeIcon size={14} />
            {t("settings.browserFontsCustomize")}
            <ChevronDown
              size={14}
              className={isExpanded ? "rotate-180 transition-transform" : "transition-transform"}
            />
          </Button>
        }
      />

      {isExpanded ? (
        <>
          <div className="glass-divider flex justify-end border-b px-4 py-3 last:border-b-0">
            <SegmentedControl<BrowserFontSettingsMode>
              className="settings-menu-control grid-cols-2"
              items={[
                { value: "default", label: t("settings.browserFontsMode.default") },
                { value: "custom", label: t("settings.browserFontsMode.custom") }
              ]}
              value={draft.fonts.mode}
              onValueChange={handleModeChange}
            />
          </div>

          <div className="glass-divider grid gap-3 border-b px-4 py-3 last:border-b-0 sm:grid-cols-2">
            {browserFontFamilyRoles.map((role) => (
              <BrowserFontFamilyInput
                key={role}
                disabled={!isCustom || isSaving}
                fontOptions={fontOptions}
                label={t(browserFontRoleLabelKeys[role])}
                role={role}
                value={draft.fonts.families[role] ?? ""}
                onValueChange={handleFontFamilyChange}
              />
            ))}
          </div>

          <div className="glass-divider grid gap-3 border-b px-4 py-3 last:border-b-0">
            <BrowserFontsPreview settings={draft} t={t} />
            {isLoadingFonts ? (
              <p className="text-xs leading-5 text-muted-foreground">{t("settings.browserFontsLoading")}</p>
            ) : null}
          </div>

          <div className="glass-divider flex flex-wrap items-center justify-end gap-2 border-b px-4 py-3 last:border-b-0">
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => void saveSettings(DEFAULT_GAME_BROWSER_SETTINGS)}
            >
              <RotateCcw size={14} />
              {t("settings.browserFontsReset")}
            </Button>
            <Button type="button" disabled={isSaving || !isDirty} onClick={() => void saveSettings(draft)}>
              {t("settings.browserFontsSave")}
            </Button>
          </div>
        </>
      ) : null}
    </>
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
    <div className="glass-inset grid gap-2 rounded-md px-3 py-3 text-xs leading-5 text-muted-foreground">
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
}

function SettingsSection({ children }: SettingsSectionProps): JSX.Element {
  return (
    <section>
      <Surface className="settings-group overflow-hidden" radius="md">
        {children}
      </Surface>
    </section>
  );
}

interface SettingsRowProps {
  control: ReactNode;
  description: string;
  title: string;
}

function SettingsRow({ control, description, title }: SettingsRowProps): JSX.Element {
  return (
    <div className="settings-row glass-divider flex flex-col gap-3 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
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

interface PortableImportDialogProps {
  isBusy: boolean;
  preview: PortableImportPreview;
  t: Translator;
  onCancel: () => void;
  onConfirm: () => void;
}

function PortableImportDialog({
  isBusy,
  preview,
  t,
  onCancel,
  onConfirm
}: PortableImportDialogProps): JSX.Element {
  return (
    <div className="app-no-drag fixed inset-0 z-50 grid place-items-center bg-black/35 p-5 backdrop-blur-sm">
      <Surface
        className="w-full max-w-[560px] overflow-hidden"
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

        <div className="grid gap-4 px-5 py-4">
          <div className="grid grid-cols-3 gap-2">
            <PortableCount label={t("settings.importRoles")} value={preview.roleCount} />
            <PortableCount label={t("settings.importWorkspaces")} value={preview.workspaceCount} />
            <PortableCount label={t("settings.importMacros")} value={preview.macroCount} />
          </div>

          <div className="min-w-0 rounded-md border border-border/40 bg-background/25 px-3 py-2">
            <p className="truncate text-[11px] font-medium leading-4 text-muted-foreground">{preview.filePath}</p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              {formatPortableSource(preview, t)}
            </p>
          </div>

          {preview.warnings.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-xs font-semibold leading-5 text-foreground">
                {t("settings.importWarnings").replace("{count}", String(preview.warnings.length))}
              </p>
              <ul className="max-h-36 space-y-1 overflow-auto pr-1 text-xs leading-5 text-muted-foreground">
                {preview.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${warning.itemName ?? index}`}>
                    {formatPortableWarning(warning, t)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">{t("settings.importNoWarnings")}</p>
          )}
        </div>

        <div className="glass-divider flex justify-end gap-2 border-t px-5 py-4">
          <Button type="button" variant="outline" disabled={isBusy} onClick={onCancel}>
            {t("settings.importCancel")}
          </Button>
          <Button type="button" disabled={isBusy} onClick={onConfirm}>
            <Upload size={14} />
            {t("settings.importConfirm")}
          </Button>
        </div>
      </Surface>
    </div>
  );
}

function PortableCount({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="glass-inset rounded-md px-3 py-2 text-center">
      <p className="text-lg font-semibold leading-6 text-foreground">{value}</p>
      <p className="mt-0.5 truncate text-[11px] font-medium leading-4 text-muted-foreground">{label}</p>
    </div>
  );
}

function formatPortableExportResult(result: PortableExportResult, t: Translator): string {
  return fillPortableCounts(t("settings.exportComplete"), result);
}

function formatPortableImportResult(result: PortableImportResult, t: Translator): string {
  return fillPortableCounts(t("settings.importComplete"), result);
}

function fillPortableCounts(
  template: string,
  counts: Pick<PortableExportResult, "macroCount" | "roleCount" | "workspaceCount">
): string {
  return template
    .replace("{roles}", String(counts.roleCount))
    .replace("{workspaces}", String(counts.workspaceCount))
    .replace("{macros}", String(counts.macroCount));
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
