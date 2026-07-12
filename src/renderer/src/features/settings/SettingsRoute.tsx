import { Download, Laptop, Moon, RefreshCw, RotateCcw, Sun } from "lucide-react";
import { type JSX, type ReactNode, useEffect } from "react";
import { useSearchParams } from "react-router";

import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/select";
import { PageFrame, SegmentedControl, Surface } from "../../components/ui/patterns";
import { emptyForm, languageLabelKeys, presetLabelKeys, resolvedThemeLabelKeys, themeLabelKeys, themeModes } from "../../app/constants";
import type { ResolvedTheme, ThemeMode } from "../../app/types";
import { languages, type Language, type Translator } from "../../i18n";
import type { AppUpdateStatus } from "../../../../shared/types";
import { readSettingsSection, settingsSectionElementIds } from "./settingsNavigation";

interface SettingsViewProps {
  language: Language;
  resolvedTheme: ResolvedTheme;
  t: Translator;
  themeMode: ThemeMode;
  updateStatus: AppUpdateStatus | null;
  updateVersion: string;
  isUpdateBusy: boolean;
  onCheckForUpdates: () => Promise<void>;
  onOpenUpdateDownload: () => Promise<void>;
  onInstallDownloadedUpdate: () => Promise<void>;
  onLanguageChange: (language: Language) => void;
  onThemeModeChange: (themeMode: ThemeMode) => void;
}

function SettingsViewBase({
  language,
  resolvedTheme,
  t,
  themeMode,
  updateStatus,
  updateVersion,
  isUpdateBusy,
  onCheckForUpdates,
  onOpenUpdateDownload,
  onInstallDownloadedUpdate,
  onLanguageChange,
  onThemeModeChange
}: SettingsViewProps): JSX.Element {
  const canCheckForUpdates = Boolean(updateStatus?.isPackaged) && !isUpdateBusy;
  const isManualUpdate = updateStatus?.installMode === "manual";
  const canInstallUpdate = updateStatus?.state === "downloaded";
  const canOpenUpdateDownload =
    isManualUpdate && updateStatus?.state === "available" && Boolean(updateStatus.downloadUrl ?? updateStatus.releasePageUrl);

  return (
    <PageFrame
      maxWidth="settings"
      className="settings-page px-6 py-7 md:px-10 md:py-10"
      contentClassName="mx-auto flex min-h-full w-full max-w-[900px] flex-col gap-8"
    >
      <header className="settings-page-header">
        <h1 className="text-[26px] font-semibold leading-tight text-foreground">{t("settings.title")}</h1>
        <p className="mt-2 max-w-2xl text-[13px] leading-5 text-muted-foreground">{t("settings.description")}</p>
      </header>

      <div className="grid gap-8">
        <SettingsSection
          id="settings-appearance"
          description={t("settings.appearanceDescription")}
          title={t("settings.appearance")}
        >
          <SettingsRow
            title={t("settings.theme")}
            description={t("settings.themeDescription").replace("{theme}", t(resolvedThemeLabelKeys[resolvedTheme]))}
            control={
              <SegmentedControl<ThemeMode>
                className="w-full grid-cols-3 sm:w-[320px]"
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
        </SettingsSection>

        <SettingsSection
          id="settings-preferences"
          description={t("settings.preferencesDescription")}
          title={t("settings.preferences")}
        >
          <SettingsRow
            title={t("settings.language")}
            description={t("settings.languageDescription")}
            control={
              <Select
                className="w-full sm:w-[240px]"
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

        <SettingsSection
          id="settings-role-defaults"
          description={t("settings.roleDefaultsDescription")}
          title={t("settings.roleDefaults")}
        >
          <SettingsRow
            title={t("settings.defaultWindow")}
            description={t("settings.defaultWindowDescription")}
            control={<ReadOnlyValue value={`${emptyForm.windowWidth} x ${emptyForm.windowHeight}`} />}
          />
          <SettingsRow
            title={t("settings.defaultPreset")}
            description={t("settings.defaultPresetDescription")}
            control={<ReadOnlyValue value={t(presetLabelKeys[emptyForm.launchPreset])} />}
          />
        </SettingsSection>

        <SettingsSection
          id="settings-updates"
          description={t("settings.updatesDescription")}
          title={t("settings.updates")}
        >
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
      </div>
    </PageFrame>
  );
}

interface SettingsSectionProps {
  children: ReactNode;
  description: string;
  id: string;
  title: string;
}

function SettingsSection({ children, description, id, title }: SettingsSectionProps): JSX.Element {
  return (
    <section id={id} className="scroll-mt-8 space-y-3">
      <div className="px-0.5">
        <h2 className="text-[14px] font-semibold leading-5 text-foreground">{title}</h2>
        <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{description}</p>
      </div>
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
  const requestedSection = searchParams.get("section");
  const activeSection = readSettingsSection(requestedSection);

  useEffect(() => {
    if (!requestedSection) {
      return;
    }

    document.getElementById(settingsSectionElementIds[activeSection])?.scrollIntoView({ block: "start" });
  }, [activeSection, requestedSection]);

  return <SettingsViewBase {...props} />;
}

export default SettingsView;
