import type { JSX } from "react";
import { RotateCcw } from "lucide-react";
import type { GpuRasterizationMode, HardwareVideoDecodeMode } from "../../../../shared/generated";
import { defaultGraphicsSettings } from "../../../../shared/graphicsSettings";
import { SettingsRow, SettingsSection } from "../../components/ui/patterns";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import type { Translator } from "../../i18n";
import { useGraphicsSettings } from "./useGraphicsSettings";
import { GraphicsInformation } from "./GraphicsInformation";

export function GraphicsSettingsSection({ t, onError }: { t: Translator; onError: (error: unknown) => void }): JSX.Element | null {
  const model = useGraphicsSettings(onError);
  const { status, saved, busy, save } = model;
  if (!status?.supported) return null;
  if (!saved) return <p role="status">{model.error ?? t("settings.graphics.loading")}</p>;
  const settings = saved.settings;
  const subordinateDisabled = busy || !settings.hardwareAcceleration;
  return <>
    <SettingsSection>
    <SettingsRow title={t("settings.graphics.acceleration")} description={t("settings.graphics.accelerationDescription")}
      control={<Switch aria-label={t("settings.graphics.acceleration")} checked={settings.hardwareAcceleration} disabled={busy}
        onCheckedChange={(hardwareAcceleration) => void save({ ...settings, hardwareAcceleration })} />} />
    <SettingsRow title={t("settings.graphics.rasterization")} description={t("settings.graphics.rasterizationDescription")}
      control={<Select value={settings.rasterization} disabled={subordinateDisabled}
        onValueChange={(rasterization) => void save({ ...settings, rasterization: rasterization as GpuRasterizationMode })}>
        <SelectTrigger className="settings-menu-control" aria-label={t("settings.graphics.rasterization")}><SelectValue /></SelectTrigger>
        <SelectContent>{(["auto", "enabled", "disabled"] as const).map((mode) =>
          <SelectItem key={mode} value={mode}>{t(`settings.graphics.${mode}`)}</SelectItem>)}</SelectContent>
      </Select>} />
    <SettingsRow title={t("settings.graphics.videoDecode")} description={t("settings.graphics.videoDecodeDescription")}
      control={<Select value={settings.videoDecode} disabled={subordinateDisabled}
        onValueChange={(videoDecode) => void save({ ...settings, videoDecode: videoDecode as HardwareVideoDecodeMode })}>
        <SelectTrigger className="settings-menu-control" aria-label={t("settings.graphics.videoDecode")}><SelectValue /></SelectTrigger>
        <SelectContent>{(["auto", "disabled"] as const).map((mode) =>
          <SelectItem key={mode} value={mode}>{t(`settings.graphics.${mode}`)}</SelectItem>)}</SelectContent>
      </Select>} />
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <Button variant="outline" disabled={busy} onClick={() => void save({ ...defaultGraphicsSettings })}>{t("settings.graphics.reset")}</Button>
      {model.pendingRestart ? <div className="flex flex-wrap items-center gap-3">
        <span role="status" className="text-control text-muted-foreground">{t("settings.graphics.restartRequired")}</span>
        <Button disabled={busy} onClick={() => void model.restart()}><RotateCcw size={14} />{t("settings.graphics.restart")}</Button>
      </div> : null}
    </div>
    {model.error ? <p role="alert" className="px-4 pb-3 text-control text-destructive">{model.error}</p> : null}
    </SettingsSection>
    <GraphicsInformation status={status} pendingRestart={model.pendingRestart}
      refreshing={model.refreshing} refresh={model.refresh} onError={model.reportError} t={t} />
  </>;
}
