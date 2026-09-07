import { useState, type JSX } from "react";
import { Copy, RefreshCw } from "lucide-react";
import type { GraphicsStatusRecord } from "../../../../shared/generated";
import type { Translator } from "../../i18n";
import { SettingsSection } from "../../components/ui/patterns";
import { Button } from "../../components/ui/button";

const featureLabels: Record<string, string> = {
  "2d_canvas": "Canvas", gpu_compositing: "Compositing", rasterization: "Rasterization",
  webgl: "WebGL", webgl2: "WebGL2", video_decode: "Video Decode", video_encode: "Video Encode",
  opengl: "OpenGL", vulkan: "Vulkan", webgpu: "WebGPU"
};

const statusLabels = {
  enabled: "settings.graphics.status.accelerated",
  disabled_software: "settings.graphics.status.disabledSoftware",
  disabled_off: "settings.graphics.status.disabled",
  disabled_off_ok: "settings.graphics.status.disabled",
  unavailable_software: "settings.graphics.status.unavailableSoftware",
  unavailable_off: "settings.graphics.status.unavailable",
  unavailable_off_ok: "settings.graphics.status.unavailable",
  enabled_on: "settings.graphics.status.enabled",
  enabled_force: "settings.graphics.status.allPages",
  enabled_readback: "settings.graphics.status.limited",
  enabled_force_on: "settings.graphics.status.enabled"
} as const;

export function GraphicsInformation({ status, pendingRestart, refreshing, refresh, onError, t }: {
  status: GraphicsStatusRecord; pendingRestart: boolean;
  refreshing: boolean; refresh: () => Promise<void>; onError: (error: unknown) => void; t: Translator;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await window.rionStudio.copyGraphicsReport();
      setCopied(true);
    } catch (error) { onError(error); }
  }
  const stateLabel = !status.initialized ? t("settings.graphics.initializing") :
    status.hardwareAcceleration === null ? t("settings.graphics.unavailable") :
    t(status.hardwareAcceleration ? "settings.graphics.accelerated" : "settings.graphics.software");
  const features = Object.fromEntries(Object.entries(status.features).map(([key, value]) =>
    [featureLabels[key] ?? key, value in statusLabels ? `${t(statusLabels[value as keyof typeof statusLabels])} (${value})` : value]));
  return (
    <SettingsSection title={t("settings.graphics.information")} aria-label={t("settings.graphics.information")}>
      <div className="grid gap-4 p-4">
        <p className="text-control text-muted-foreground">{stateLabel}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={refreshing} onClick={() => { setCopied(false); void refresh(); }}>
            <RefreshCw size={14} />{t("settings.graphics.refresh")}
          </Button>
          <Button variant="outline" onClick={() => void copy()}><Copy size={14} />{t(copied ? "settings.graphics.copied" : "settings.graphics.copy")}</Button>
        </div>
        {status.error ? <p role="alert" className="text-control text-destructive">{t("settings.graphics.diagnosticsFailed")} {status.error}</p> : null}
        {!status.initialized ? <p role="status" className="text-control text-muted-foreground">{t("settings.graphics.initializing")}</p> : null}
        <InformationGroup title={t("settings.graphics.features")} values={features} t={t} />
        {status.devices.length ? status.devices.map((device, index) =>
          <InformationGroup key={index} title={`${t("settings.graphics.device")} ${index + 1}`} values={device} t={t} />
        ) : <InformationGroup title={t("settings.graphics.device")} values={{}} t={t} />}
        <InformationGroup title={t("settings.graphics.driver")} values={status.driver} t={t} />
        <InformationGroup title={t("settings.graphics.versions")} values={status.versions} t={t} />
        <div className="grid gap-2 text-control"><h3 className="font-semibold">{t("settings.graphics.problems")}</h3>
          <p className="break-words text-muted-foreground">{status.problems.join("\n") || t("settings.graphics.unavailable")}</p>
        </div>
        {pendingRestart ? <p className="text-control text-muted-foreground">{t("settings.graphics.currentSession")}</p> : null}
      </div>
    </SettingsSection>
  );
}

function InformationGroup({ title, values, t }: { title: string; values: Record<string, string>; t: Translator }): JSX.Element {
  return <div className="grid gap-2 text-control"><h3 className="font-semibold">{title}</h3>
    {Object.keys(values).length ? <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2">
      {Object.entries(values).map(([key, value]) => <div key={key} className="contents">
        <dt className="break-words text-muted-foreground">{key}</dt><dd className="min-w-0 break-words font-mono">{value}</dd>
      </div>)}
    </dl> : <p className="text-muted-foreground">{t("settings.graphics.unavailable")}</p>}
  </div>;
}
