import { Download, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { type JSX, useCallback, useEffect, useMemo, useState } from "react";

import type { LogEntry, LogLevel, LogSource, LogStorageStatus } from "../../../../shared/types";
import { useConfirmation } from "../../components/confirmation";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";

const ALL = "all";

export function DiagnosticsSettingsSection({ t, onError }: { t: Translator; onError: (error: unknown) => void }): JSX.Element {
  const confirm = useConfirmation();
  const [status, setStatus] = useState<LogStorageStatus | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<LogLevel | typeof ALL>(ALL);
  const [source, setSource] = useState<LogSource | typeof ALL>(ALL);
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <Surface className="settings-group overflow-hidden [&>*:last-child]:border-b-0" radius="md">
          <div className="settings-row glass-divider flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[13px] font-semibold leading-5 text-foreground">{t("settings.logsStorage")}</p>
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
              <p className="text-[13px] font-semibold leading-5 text-foreground">{t("settings.logsLevel")}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t("settings.logsLevelDescription")}</p>
            </div>
            <Select value={status?.currentLevel ?? "info"} onValueChange={(value) => void run(() => window.rionStudio.setLogLevel(value as LogLevel))}>
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
              <p className="whitespace-nowrap text-[13px] font-semibold leading-5 text-foreground">{t("settings.logsViewer")}</p>
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
          <div className="max-h-[430px] overflow-auto bg-black/5 font-mono text-[11px] dark:bg-black/20">
            {entries.length ? entries.map((entry) => <LogEntryRow key={entry.id} entry={entry} t={t} />) : <p className="p-6 text-center text-muted-foreground">{t("settings.logsEmpty")}</p>}
          </div>
          {cursor ? <div className="border-t border-border/50 p-3 text-center"><Button variant="outline" disabled={busy} onClick={() => void loadMore()}>{t("settings.logsLoadMore")}</Button></div> : null}
        </Surface>
      </section>
    </div>
  );
}

function LogEntryRow({ entry, t }: { entry: LogEntry; t: Translator }): JSX.Element {
  const source = entry.source === "preload"
    ? `${entry.source} (${t("settings.logsLegacySource")})`
    : entry.source;
  return <details className="border-b border-border/40 px-3 py-2 last:border-0"><summary className="cursor-pointer list-none"><span className="text-muted-foreground">{new Date(entry.timestamp).toLocaleTimeString()}</span> <span className={entry.level === "error" ? "text-destructive" : entry.level === "warn" ? "text-amber-600" : "text-foreground"}>[{entry.level.toUpperCase()}]</span> <span className="text-muted-foreground">[{source}]</span> {entry.message}</summary>{entry.context || entry.error ? <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-black/10 p-2 text-muted-foreground">{JSON.stringify({ context: entry.context, error: entry.error }, null, 2)}</pre> : null}</details>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
