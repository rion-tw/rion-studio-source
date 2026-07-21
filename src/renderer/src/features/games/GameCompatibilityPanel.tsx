import {
  AlertTriangle,
  CheckCircle2,
  Gamepad2,
  Loader2,
  XCircle
} from "lucide-react";
import type { JSX } from "react";

import { EmptyState } from "../../components/EmptyState";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { FieldHeader, Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import type {
  Game,
  GameCompatibilityReport,
  GameCompatibilityRunStatus
} from "../../../../shared/types";

interface GameCompatibilityPanelProps {
  game: Game;
  report?: GameCompatibilityReport;
  runStatus?: GameCompatibilityRunStatus;
  t: Translator;
  onApply: () => void;
  onCancel: () => void;
  onOpenGraphicsSettings: () => void;
  onRun: () => void;
}

export function GameCompatibilityPanel({
  game,
  report,
  runStatus,
  t,
  onApply,
  onCancel,
  onOpenGraphicsSettings,
  onRun
}: GameCompatibilityPanelProps): JSX.Element {
  const recommendation = report?.recommendation;
  const observations = report?.observations;
  const observationItems = observations ? [
    ["games.compatibility.observation.embedded", observations.lastEmbeddedSuccessAt],
    ["games.compatibility.observation.external", observations.lastExternalSuccessAt],
    ["games.compatibility.observation.fallback", observations.lastFallbackAt],
    ["games.compatibility.observation.launchFailure", observations.lastLaunchFailureAt, observations.lastLaunchFailureCode],
  ].filter((item) => item[1]) : [];

  return (
    <Surface className="grid gap-4 p-4" variant="inset">
      <FieldHeader
        title={t("games.tab.compatibility")}
        description={t("games.compatibility.notCheckedDescription")}
      />
      <div className="grid gap-3 rounded-lg bg-muted/35 p-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 shrink-0 text-warning-foreground" size={18} />
          <div>
            <p className="text-sm font-semibold">{t("games.compatibility.noticeTitle")}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("games.compatibility.notice")}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {runStatus ? (
            <Button type="button" variant="outline" onClick={onCancel}>
              <Loader2 className="spin" size={15} />
              {t("games.compatibility.cancel")}
            </Button>
          ) : (
            <Button type="button" onClick={onRun}>{t("games.compatibility.run")}</Button>
          )}
          {recommendation?.mode === "external" && game.browserLaunchMode !== "external" ? (
            <Button type="button" variant="secondary" onClick={onApply}>{t("games.compatibility.apply")}</Button>
          ) : null}
          {recommendation?.reason === "graphics_unavailable" ? (
            <Button type="button" variant="secondary" onClick={onOpenGraphicsSettings}>
              {t("games.compatibility.graphicsSettings")}
            </Button>
          ) : null}
        </div>
        {runStatus ? (
          <p className="text-xs text-muted-foreground">
            {t("games.compatibility.phase").replace(
              "{phase}",
              t(`games.compatibility.phase.${runStatus.phase}` as "games.compatibility.phase.loading")
            )}
          </p>
        ) : null}
      </div>

      {report?.checkedAt ? (
        <div className="grid gap-4 rounded-lg bg-muted/35 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusIcon state={report.load?.state} />
            <p className="font-semibold">
              {recommendation?.reason === "graphics_unavailable"
                ? t("games.compatibility.graphicsLimited")
                : report.load?.state === "available"
                  ? t("games.compatibility.available")
                  : report.load?.state === "cancelled"
                    ? t("games.compatibility.cancelled")
                    : t("games.compatibility.failed")}
            </p>
            {report.isStale ? <Badge variant="warning">{t("games.compatibility.stale")}</Badge> : null}
            <span className="text-xs text-muted-foreground">{new Date(report.checkedAt).toLocaleString()}</span>
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <Datum label={t("games.compatibility.duration")} value={report.load ? `${report.load.durationMs} ms` : "—"} />
            <Datum label={t("games.compatibility.origin")} value={report.load?.finalOrigin ?? "—"} />
            <Datum label="WebGL / WebGL2" value={`${formatAvailability(report.graphics?.webgl, t)} / ${formatAvailability(report.graphics?.webgl2, t)}`} />
            <Datum label="WebGPU" value={formatAvailability(report.graphics?.webgpu, t)} />
            <Datum label={t("games.compatibility.renderer")} value={report.graphics?.renderer ?? "—"} />
            <Datum label={t("games.compatibility.chrome")} value={report.systemChrome ? formatAvailability(report.systemChrome.state, t) : "—"} />
            <Datum label={t("games.compatibility.recommendation")} value={recommendation ? t(`games.compatibility.recommendation.${recommendation.reason}` as "games.compatibility.recommendation.embedded_available") : "—"} />
            <Datum label={t("games.compatibility.errorCode")} value={report.load?.errorCode ?? "—"} />
          </div>
        </div>
      ) : (
        <EmptyState
          className="min-h-44"
          icon={Gamepad2}
          title={t("games.compatibility.notChecked")}
          description={t("games.compatibility.notCheckedDescription")}
        />
      )}

      {observationItems.length ? (
        <div className="grid gap-3 rounded-lg bg-muted/35 p-3">
          <p className="text-sm font-semibold">{t("games.compatibility.observations")}</p>
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            {observationItems.map(([labelKey, timestamp, code]) => (
              <Datum
                key={labelKey}
                label={t(labelKey as "games.compatibility.observation.embedded")}
                value={timestamp ? `${new Date(timestamp).toLocaleString()}${code ? ` · ${code}` : ""}` : "—"}
              />
            ))}
          </div>
        </div>
      ) : null}
    </Surface>
  );
}

function Datum({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0 rounded-md bg-background/55 p-3">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 break-words font-medium">{value}</p>
    </div>
  );
}

function formatAvailability(
  value: "available" | "unavailable" | "unknown" | undefined,
  t: Translator
): string {
  return value
    ? t(`games.compatibility.capability.${value}` as "games.compatibility.capability.available")
    : "—";
}

function StatusIcon({ state }: { state?: "available" | "failed" | "cancelled" }): JSX.Element {
  return state === "available" ? (
    <CheckCircle2 className="text-success" size={19} />
  ) : state === "failed" ? (
    <XCircle className="text-destructive" size={19} />
  ) : (
    <AlertTriangle className="text-warning-foreground" size={19} />
  );
}
