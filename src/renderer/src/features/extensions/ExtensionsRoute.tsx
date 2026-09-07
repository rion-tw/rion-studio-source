import { ArrowLeft, ArrowRight, Puzzle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ExtensionPackageRecord, ExtensionSnapshotRecord } from "../../../../shared/generated";
import type { ExtensionStoreState, ExtensionUserCommand } from "../../../../shared/extensions";
import type { Role } from "../../../../shared/types";
import type { Translator } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Checkbox } from "../../components/ui/checkbox";
import { Badge } from "../../components/ui/badge";
import { DialogLayer, PageFrame, PageHeader, SegmentedControl, StatusCallout, Surface } from "../../components/ui/patterns";

const emptyStore: ExtensionStoreState = { url: "", extensionId: null, canGoBack: false, canGoForward: false, loading: false, failed: false };

export default function ExtensionsRoute({ roles, t, covered = false }: { roles: Role[]; t: Translator; covered?: boolean }) {
  const [snapshot, setSnapshot] = useState<ExtensionSnapshotRecord>({ revision: -1, installed: [], roles: [] });
  const [store, setStore] = useState(emptyStore);
  const [tab, setTab] = useState<"installed" | "store">("installed");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<ExtensionPackageRecord | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [remove, setRemove] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const pending = useRef<string | null>(null);
  const commandSequence = useRef(0);
  const alive = useRef(true);
  const apply = useCallback((next: ExtensionSnapshotRecord) => {
    setSnapshot(previous => next.revision > previous.revision ? next : previous);
  }, []);

  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.rionStudio.onExtensionsChanged(apply);
    const unstore = window.rionStudio.onExtensionStoreChanged(setStore);
    void window.rionStudio.extensions({ type: "snapshot" }).then(r => { if (alive.current) apply(r.snapshot); }, () => setError(t("extensions.failed")));
    return () => {
      alive.current = false;
      unsubscribe(); unstore();
      void window.rionStudio.extensionStore({ action: "hide" }).catch(() => undefined);
      if (pending.current) void window.rionStudio.extensions({ type: "cancel", operationId: pending.current }).catch(() => undefined);
    };
  }, [apply, t]);

  useEffect(() => {
    const element = viewport.current;
    if (tab !== "store" || selection || covered || !element) {
      void window.rionStudio.extensionStore({ action: "hide" }).catch(() => undefined);
      return;
    }
    const update = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      void window.rionStudio.extensionStore({ action: "show", bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
        .then(setStore, () => setError(t("extensions.failed")));
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); void window.rionStudio.extensionStore({ action: "hide" }).catch(() => undefined); };
  }, [tab, selection, covered, t]);

  useEffect(() => {
    if (!selection) return;
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, [selection]);

  const command = async (input: ExtensionUserCommand) => {
    const sequence = ++commandSequence.current;
    setBusy(true); setError("");
    try {
      const result = await window.rionStudio.extensions(input);
      if (alive.current) apply(result.snapshot);
      return result;
    } catch { if (alive.current && sequence === commandSequence.current) setError(t("extensions.failed")); return null; }
    finally { if (alive.current && sequence === commandSequence.current) setBusy(false); }
  };
  const close = () => {
    if (busy) return;
    if (pending.current) void command({ type: "cancel", operationId: pending.current });
    pending.current = null; setOperation(null); setSelection(null); setRemove(false);
  };
  const install = async () => {
    const id = store.extensionId;
    if (!id) return;
    const existing = snapshot.installed.find(p => p.id === id);
    if (existing) { await window.rionStudio.extensionStore({ action: "hide" }); setSelection(existing); setRemove(existing.removed); setSelectedRoles(existing.enabledRoleIds); return; }
    const operationId = crypto.randomUUID();
    pending.current = operationId;
    const result = await command({ type: "prepare", id, operationId });
    if (!alive.current || pending.current !== operationId) return;
    if (result?.prepared) {
      await window.rionStudio.extensionStore({ action: "hide" });
      setSelection(result.prepared.package); setSelectedRoles([]); setOperation(operationId);
    } else pending.current = null;
  };
  const save = async () => {
    if (!selection) return;
    const result = await command(remove ? { type: "remove", id: selection.id } : operation
      ? { type: "install", operationId: operation, roleIds: selectedRoles }
      : { type: "configure", id: selection.id, roleIds: selectedRoles });
    if (result) { pending.current = null; setOperation(null); setSelection(null); setRemove(false); }
  };

  return <PageFrame className="h-full" contentClassName="flex h-full min-h-0 min-w-0 w-full flex-col gap-4">
    <PageHeader title={t("extensions.title")} description={t("extensions.description")} />
    <div className="flex shrink-0 items-center gap-2">
      <SegmentedControl className="grid-cols-2" value={tab} onValueChange={setTab} items={[
        { value: "installed", label: t("extensions.installed") },
        { value: "store", label: t("extensions.store") }
      ]} />
    </div>
    {error && <StatusCallout tone="destructive" role="alert">{error}</StatusCallout>}
    {tab === "store" ? <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" aria-label={t("extensions.back")} disabled={!store.canGoBack} onClick={() => void window.rionStudio.extensionStore({ action: "back" }).then(setStore).catch(() => setError(t("extensions.failed")))}><ArrowLeft size={14} /></Button>
        <Button variant="ghost" aria-label={t("extensions.forward")} disabled={!store.canGoForward} onClick={() => void window.rionStudio.extensionStore({ action: "forward" }).then(setStore).catch(() => setError(t("extensions.failed")))}><ArrowRight size={14} /></Button>
        <Button variant="ghost" aria-label={t("extensions.reload")} onClick={() => void window.rionStudio.extensionStore({ action: "reload" }).then(setStore).catch(() => setError(t("extensions.failed")))}><RefreshCw size={14} /></Button>
        <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{store.failed ? t("extensions.failed") : store.url}</span>
        <Button disabled={!store.extensionId || busy || store.loading} onClick={() => void install().catch(() => setError(t("extensions.failed")))}>{busy ? t("extensions.preparing") : snapshot.installed.some(p => p.id === store.extensionId) ? t("extensions.manage") : t("extensions.install")}</Button>
        {busy && pending.current && <Button variant="ghost" onClick={() => { const id = pending.current; pending.current = null; commandSequence.current += 1; setBusy(false); if (id) void window.rionStudio.extensions({ type: "cancel", operationId: id }).catch(() => setError(t("extensions.failed"))); }}>{t("extensions.cancel")}</Button>}
      </div>
      <div ref={viewport} className="min-h-[240px] min-w-0 w-full flex-1 overflow-x-hidden rounded-md border border-border" aria-label={t("extensions.store")} />
    </div> : <div className="grid gap-3">
      <Input aria-label={t("extensions.search")} placeholder={t("extensions.search")} value={query} onChange={e => setQuery(e.target.value)} />
      {snapshot.installed.filter(p => `${p.name} ${p.id}`.toLowerCase().includes(query.toLowerCase())).map(p => <Surface key={p.id} className="flex items-center gap-3 p-4">
        <Puzzle size={20} className="text-muted-foreground" />
        <div className="min-w-0 flex-1"><p className="truncate text-heading">{p.name}</p><p className="text-caption text-muted-foreground">{p.version} · {p.enabledRoleIds.length} {t("extensions.roles")}</p></div>
        {p.removed && <Badge>{t("extensions.removalPending")}</Badge>}
        {snapshot.roles.some(r => r.extensionIds.includes(p.id) && r.status === "failed") && <Badge variant="destructive">{t("extensions.loadFailed")}</Badge>}
        <Button variant="outline" onClick={() => { setSelection(p); setRemove(p.removed); setSelectedRoles(p.enabledRoleIds); }}>{t(p.removed ? "extensions.retryRemoval" : "extensions.manage")}</Button>
      </Surface>)}
      {snapshot.installed.length === 0 && <Surface className="grid justify-items-center gap-3 p-6"><Puzzle size={24} /><p>{t("extensions.empty")}</p><Button onClick={() => setTab("store")}>{t("extensions.store")}</Button></Surface>}
    </div>}
    {selection && <DialogLayer backdropLabel={t("extensions.cancel")} onDismiss={close}>
      <Surface variant="modal" className="max-h-[80vh] w-full max-w-xl overflow-auto p-6">
        <div ref={dialog} role="dialog" aria-modal="true" aria-label={selection.name} tabIndex={-1} className="grid gap-4" onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); close(); }
          if (event.key === "Tab") {
            const targets = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? [])];
            const first = targets[0], last = targets.at(-1);
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
          <h2 className="text-title">{selection.name}</h2>
          <p className="text-caption text-muted-foreground">{selection.version} · {selection.id}</p>
          <StatusCallout>{t(remove ? "extensions.removeDescription" : "extensions.compatibility")}</StatusCallout>
          <div><h3 className="text-heading">{t("extensions.permissions")}</h3><p className="break-words text-caption">{selection.permissions.join(", ") || t("extensions.none")}</p></div>
          <div className="grid gap-3"><h3 className="text-heading">{t("extensions.roles")}</h3>{roles.map(role => {
            const runtime = snapshot.roles.find(r => r.roleId === role.id);
            const enabled = selectedRoles.includes(role.id);
            const loaded = runtime?.extensionIds.includes(selection.id) && runtime.status === "loaded";
            const pendingChange = !!runtime && enabled !== !!runtime.extensionIds.includes(selection.id);
            return <label key={role.id} className="flex items-center gap-3 text-control"><Checkbox disabled={busy || remove} checked={enabled} onCheckedChange={checked => setSelectedRoles(ids => checked ? [...ids, role.id] : ids.filter(id => id !== role.id))} />
              <span className="flex-1">{role.name}</span><span className="text-caption text-muted-foreground">{runtime?.status === "failed" && runtime.extensionIds.includes(selection.id) ? t("extensions.loadFailed") : pendingChange ? t("extensions.pending") : loaded ? t("extensions.loaded") : enabled ? t("extensions.enabled") : t("extensions.disabled")}</span></label>;
          })}</div>
          <p className="text-caption text-muted-foreground">{t("extensions.nextLaunch")}</p>
          {error && <StatusCallout tone="destructive" role="alert">{error}</StatusCallout>}
          <div className="flex justify-end gap-2">{!operation && !remove && <Button variant="destructive" disabled={busy} onClick={() => setRemove(true)}>{t("extensions.remove")}</Button>}<Button variant="ghost" disabled={busy} onClick={close}>{t("extensions.cancel")}</Button><Button disabled={busy} variant={remove ? "destructive" : "default"} onClick={() => void save()}>{t(remove ? "extensions.confirmRemove" : operation ? "extensions.confirmInstall" : "extensions.save")}</Button></div>
        </div>
      </Surface>
    </DialogLayer>}
  </PageFrame>;
}
