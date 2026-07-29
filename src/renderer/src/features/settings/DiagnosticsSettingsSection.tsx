import { Download, ExternalLink, Gauge, RefreshCw, Trash2 } from "lucide-react";
import { type JSX, useCallback, useEffect, useMemo, useState } from "react";

import type {
  BrowserPerformanceDiagnostics,
  LogEntry,
  LogLevel,
  LogSource,
  LogStorageStatus,
  Role
} from "../../../../shared/types";
import { useConfirmation } from "../../components/confirmation";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";

const ALL = "all";

export function DiagnosticsSettingsSection({
  roles,
  t,
  onError
}: {
  roles: Role[];
  t: Translator;
  onError: (error: unknown) => void;
}): JSX.Element {
  const confirm = useConfirmation();
  const [status, setStatus] = useState<LogStorageStatus | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<LogLevel | typeof ALL>(ALL);
  const [source, setSource] = useState<LogSource | typeof ALL>(ALL);
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [performanceBusy, setPerformanceBusy] = useState(false);
  const [performance, setPerformance] = useState<BrowserPerformanceDiagnostics | null>(null);

  const query = useMemo(() => ({
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(level !== ALL ? { levels: [level] } : {}),
    ...(source !== ALL ? { sources: [source] } : {}),
    limit: 100
  }), [level, search, source]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [nextStatus, page] = await Promise.all([
        window.rionStudio.getLogStatus(), window.rionStudio.queryLogs(query)
      ]);
      setStatus(nextStatus);
      setEntries(page.entries);
      setCursor(page.nextCursor);
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  }, [onError, query]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => window.rionStudio.onLogEntryAdded((entry) => {
    if (!live) return;
    if (level !== ALL && entry.level !== level) return;
    if (source !== ALL && entry.source !== source) return;
    if (search.trim() && !JSON.stringify(entry).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) return;
    setEntries((current) => [entry, ...current].slice(0, 500));
  }), [level, live, search, source]);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try { await action(); await refresh(); } catch (error) { onError(error); }
    finally { setBusy(false); }
  }

  async function clearLogs(): Promise<void> {
    const approved = await confirm({
      title: t("settings.logsClearTitle"), description: t("settings.logsClearDescription"),
      confirmLabel: t("settings.logsClear"), cancelLabel: t("confirm.cancel"), tone: "destructive"
    });
    if (approved) await run(() => window.rionStudio.clearLogs());
  }

  async function loadMore(): Promise<void> {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await window.rionStudio.queryLogs({ ...query, cursor });
      setEntries((current) => [...current, ...page.entries]);
      setCursor(page.nextCursor);
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  }

  async function runPerformanceDiagnostics(): Promise<void> {
    setPerformanceBusy(true);
    try {
      setPerformance(await window.rionStudio.collectBrowserPerformanceDiagnostics());
    } catch (error) {
      onError(error);
    } finally {
      setPerformanceBusy(false);
    }
  }

  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <Surface className="settings-group overflow-hidden" radius="md">
          <div className="settings-row flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-body font-semibold text-foreground">{t("settings.performanceDiagnosticsTitle")}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t("settings.performanceDiagnosticsDescription")}</p>
              <p className="mt-1 text-caption text-warning-foreground">{t("settings.performanceDiagnosticsHint")}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={performanceBusy}
              onClick={() => void runPerformanceDiagnostics()}
            >
              <Gauge className={performanceBusy ? "animate-pulse" : undefined} size={14} />
              {t(performanceBusy ? "settings.performanceDiagnosticsRunning" : "settings.performanceDiagnosticsRun")}
            </Button>
          </div>
          {performance ? (
            <PerformanceDiagnosticsResult performance={performance} roles={roles} t={t} />
          ) : null}
        </Surface>
      </section>

      <section className="grid gap-2">
        <Surface className="settings-group overflow-hidden [&>*:last-child]:border-b-0" radius="md">
          <div className="settings-row glass-divider flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-body font-semibold text-foreground">{t("settings.logsStorage")}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {status ? t("settings.logsStorageSummary")
                  .replace("{entries}", String(status.entryCount))
                  .replace("{size}", formatBytes(status.totalBytes))
                  .replace("{days}", String(status.retentionDays))
                  .replace("{limit}", formatBytes(status.maxBytes)) : t("settings.logsLoading")}
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => void window.rionStudio.revealLogs().catch(onError)}><ExternalLink size={14} />{t("settings.logsOpenFolder")}</Button>
              <Button variant="outline" disabled={busy} onClick={() => void run(() => window.rionStudio.exportDiagnostics())}><Download size={14} />{t("settings.logsExport")}</Button>
              <Button variant="outline" disabled={busy} onClick={() => void clearLogs()}><Trash2 size={14} />{t("settings.logsClear")}</Button>
            </div>
          </div>
          <div className="settings-row flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-body font-semibold text-foreground">{t("settings.logsLevel")}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t("settings.logsLevelDescription")}</p>
            </div>
            <Select value={status?.currentLevel ?? "debug"} onValueChange={(value) => void run(() => window.rionStudio.setLogLevel(value as LogLevel))}>
              <SelectTrigger className="w-32 settings-menu-control"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="info">Info</SelectItem><SelectItem value="debug">Debug</SelectItem></SelectContent>
            </Select>
          </div>
        </Surface>
      </section>

      <section className="grid gap-2">
        <Surface className="settings-group overflow-hidden [&>*:last-child]:border-b-0" radius="md">
          <div className="settings-row glass-divider flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="whitespace-nowrap text-body font-semibold text-foreground">{t("settings.logsViewer")}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t("settings.logsViewerDescription")}</p>
            </div>
            <div className="flex w-full flex-wrap justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
                <RefreshCw className={busy ? "animate-spin" : ""} size={14} />
                {t("settings.logsRefresh")}
              </Button>
              <Input className="min-w-44 w-auto" value={search} placeholder={t("settings.logsSearch")} onChange={(event) => setSearch(event.target.value)} />
              <Select value={level} onValueChange={(value) => setLevel(value as LogLevel | typeof ALL)}>
                <SelectTrigger className="w-28 settings-menu-control"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={ALL}>{t("settings.logsAllLevels")}</SelectItem>{(["debug", "info", "warn", "error"] as const).map((item) => <SelectItem key={item} value={item}>{item.toUpperCase()}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={source} onValueChange={(value) => setSource(value as LogSource | typeof ALL)}>
                <SelectTrigger className="w-36 settings-menu-control"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={ALL}>{t("settings.logsAllSources")}</SelectItem>{(["main", "renderer", "ipc", "browser", "macro", "persistence", "update"] as const).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
              </Select>
              <Button type="button" variant={live ? "default" : "outline"} onClick={() => setLive((value) => !value)}>{t(live ? "settings.logsLiveOn" : "settings.logsLiveOff")}</Button>
            </div>
          </div>
          <div className="max-h-[430px] overflow-auto bg-muted/35 font-mono text-caption">
            {entries.length ? entries.map((entry) => <LogEntryRow key={entry.id} entry={entry} t={t} />) : <p className="p-6 text-center text-muted-foreground">{t("settings.logsEmpty")}</p>}
          </div>
          {cursor ? <div className="border-t border-border/50 p-3 text-center"><Button variant="outline" disabled={busy} onClick={() => void loadMore()}>{t("settings.logsLoadMore")}</Button></div> : null}
        </Surface>
      </section>
    </div>
  );
}

function PerformanceDiagnosticsResult({
  performance,
  roles,
  t
}: {
  performance: BrowserPerformanceDiagnostics;
  roles: Role[];
  t: Translator;
}): JSX.Element {
  if (performance.status !== "available") {
    return (
      <div className="border-t border-border/50 px-4 py-3 text-xs leading-5 text-muted-foreground">
        {t(performance.status === "noRunningRole"
          ? "settings.performanceDiagnosticsNoRunningRole"
          : "settings.performanceDiagnosticsNoVisibleWindow")}
      </div>
    );
  }
  return (
    <div className="grid gap-3 border-t border-border/50 px-4 py-3">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-caption text-muted-foreground">
        <span>{t("settings.performanceDiagnosticsDisplay")}: {formatHertz(performance.displayRefreshRateHz, t)}</span>
        <span>{t("settings.performanceDiagnosticsWindowFocus")}: {t(performance.windowFocused
          ? "settings.performanceDiagnosticsFocused"
          : "settings.performanceDiagnosticsUnfocused")}</span>
        <span>{new Date(performance.capturedAt).toLocaleString()}</span>
      </div>
      {performance.surfaces.map((surface) => {
        const roleName = roles.find((role) => role.id === surface.roleId)?.name ?? surface.roleId;
        return (
          <div key={surface.roleId} className="rounded-md border border-border/60 bg-background/40 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-foreground">{roleName}</p>
                {surface.origin ? <p className="text-micro text-muted-foreground">{surface.origin}</p> : null}
              </div>
              <p className="font-mono text-lg font-semibold text-foreground">
                {formatFps(surface.averageFps)} FPS
              </p>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-caption sm:grid-cols-4">
              <DiagnosticValue label={t("settings.performanceDiagnosticsVisibility")} value={t(`settings.performanceDiagnosticsVisibility.${surface.documentVisibilityState}`)} />
              <DiagnosticValue label={t("settings.performanceDiagnosticsPageFocus")} value={t(surface.documentHasFocus ? "settings.performanceDiagnosticsFocused" : "settings.performanceDiagnosticsUnfocused")} />
              <DiagnosticValue label={t("settings.performanceDiagnosticsP95")} value={formatMilliseconds(surface.p95FrameIntervalMs, t)} />
              <DiagnosticValue label={t("settings.performanceDiagnosticsP99")} value={formatMilliseconds(surface.p99FrameIntervalMs, t)} />
              <DiagnosticValue label={t("settings.performanceDiagnosticsViewport")} value={`${Math.round(surface.viewportWidth)} × ${Math.round(surface.viewportHeight)} @ ${surface.devicePixelRatio.toFixed(2)}×`} />
              <DiagnosticValue label={t("settings.performanceDiagnosticsSlowFrames")} value={formatCount(surface.slowFrameCount, t)} />
              <DiagnosticValue label={t("settings.performanceDiagnosticsMissedVsync")} value={formatCount(surface.missedVsyncCount, t)} />
              <DiagnosticValue label={t("settings.performanceDiagnosticsLongTasks")} value={formatLongTasks(surface, t)} />
              <DiagnosticValue label="WebGL 2" value={t(`settings.performanceDiagnosticsCapability.${surface.graphics.webgl2}`)} />
              <DiagnosticValue label="WebGPU" value={t(`settings.performanceDiagnosticsCapability.${surface.graphics.webgpu}`)} />
              <DiagnosticValue label={t("settings.performanceDiagnosticsHighRefresh")} value={t(`settings.performanceDiagnosticsHighRefresh.${surface.highRefreshRateStatus}`)} />
              <DiagnosticValue label={t("settings.performanceDiagnosticsFrames")} value={String(surface.frameCount)} />
            </div>
            <p className="mt-3 text-caption text-muted-foreground">
              {performanceFinding(performance, surface, t)}
            </p>
            {surface.graphics.renderer ? (
              <p className="mt-1 break-all text-micro text-muted-foreground">GPU: {surface.graphics.renderer}</p>
            ) : null}
            {surface.error || surface.graphics.error ? (
              <p className="mt-2 break-words text-micro text-destructive">{surface.error ?? surface.graphics.error}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function DiagnosticValue({ label, value }: { label: string; value: string }): JSX.Element {
  return <div><p className="text-muted-foreground">{label}</p><p className="mt-0.5 break-words font-medium text-foreground">{value}</p></div>;
}

function performanceFinding(
  performance: BrowserPerformanceDiagnostics,
  surface: BrowserPerformanceDiagnostics["surfaces"][number],
  t: Translator
): string {
  if (surface.error) return t("settings.performanceDiagnosticsFindingFailed");
  if (surface.documentVisibilityState !== "visible") return t("settings.performanceDiagnosticsFindingHidden");
  if (!surface.documentHasFocus) return t("settings.performanceDiagnosticsFindingUnfocused");
  if ((surface.longTaskCount ?? 0) > 0 && (surface.longestTaskMs ?? 0) >= 50) {
    return t("settings.performanceDiagnosticsFindingLongTasks")
      .replace("{count}", String(surface.longTaskCount))
      .replace("{longest}", (surface.longestTaskMs ?? 0).toFixed(1));
  }
  if ((surface.missedVsyncCount ?? 0) > 0) {
    return t("settings.performanceDiagnosticsFindingFramePacing")
      .replace("{count}", String(surface.missedVsyncCount));
  }
  if (surface.averageFps === undefined || performance.displayRefreshRateHz === undefined) {
    return t("settings.performanceDiagnosticsFindingIncomplete");
  }
  if (surface.averageFps < performance.displayRefreshRateHz * 0.8) {
    return t("settings.performanceDiagnosticsFindingBelowRefresh")
      .replace("{fps}", surface.averageFps.toFixed(1))
      .replace("{hz}", performance.displayRefreshRateHz.toFixed(0));
  }
  return t("settings.performanceDiagnosticsFindingNearRefresh");
}

function formatFps(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(1);
}

function formatHertz(value: number | undefined, t: Translator): string {
  return value === undefined ? t("settings.performanceDiagnosticsUnknown") : `${value.toFixed(0)} Hz`;
}

function formatMilliseconds(value: number | undefined, t: Translator): string {
  return value === undefined ? t("settings.performanceDiagnosticsUnknown") : `${value.toFixed(2)} ms`;
}

function formatCount(value: number | undefined, t: Translator): string {
  return value === undefined ? t("settings.performanceDiagnosticsUnknown") : String(value);
}

function formatLongTasks(
  surface: BrowserPerformanceDiagnostics["surfaces"][number],
  t: Translator
): string {
  if (surface.longTaskCount === undefined) return t("settings.performanceDiagnosticsUnsupported");
  return t("settings.performanceDiagnosticsLongTaskValue")
    .replace("{count}", String(surface.longTaskCount))
    .replace("{duration}", (surface.longTaskTotalDurationMs ?? 0).toFixed(1));
}

function LogEntryRow({ entry, t }: { entry: LogEntry; t: Translator }): JSX.Element {
  const source = entry.source === "preload"
    ? `${entry.source} (${t("settings.logsLegacySource")})`
    : entry.source;
  return <details className="border-b border-border/40 px-3 py-2 last:border-0"><summary className="cursor-pointer list-none"><span className="text-muted-foreground">{new Date(entry.timestamp).toLocaleTimeString()}</span> <span className={entry.level === "error" ? "text-destructive" : entry.level === "warn" ? "text-warning-foreground" : "text-foreground"}>[{entry.level.toUpperCase()}]</span> <span className="text-muted-foreground">[{source}]</span> {entry.message}</summary>{entry.context || entry.error ? <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xs bg-muted/55 p-2 text-muted-foreground">{JSON.stringify({ context: entry.context, error: entry.error }, null, 2)}</pre> : null}</details>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
