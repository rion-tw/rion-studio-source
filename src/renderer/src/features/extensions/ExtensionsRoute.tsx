import { ArrowLeft, ArrowRight, Plus, Puzzle, Search, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ExtensionPackageRecord, ExtensionSnapshotRecord } from "../../../../shared/generated";
import type { ExtensionStoreState, ExtensionUserCommand } from "../../../../shared/extensions";
import type { AppLanguage, Role } from "../../../../shared/types";
import type { TranslationKey, Translator } from "../../i18n";
import { Button } from "../../components/ui/button";
import { SearchField } from "../../components/SearchField";
import { EmptyState } from "../../components/EmptyState";
import { ExtensionCard } from "./ExtensionCard";
import { ExtensionDialog } from "./ExtensionDialog";
import { PageFrame, PageHeader, StatusCallout } from "../../components/ui/patterns";

const emptyStore: ExtensionStoreState = { url: "", extensionId: null, canGoBack: false, canGoForward: false, loading: false, failed: false };

const extensionErrorKeys: Readonly<Record<string, TranslationKey>> = {
  EXTENSIONS_STORE_UNAVAILABLE: "extensions.storeUnavailable",
  EXTENSIONS_PACKAGE_TOO_LARGE: "extensions.packageTooLarge",
  EXTENSIONS_UNPACKED_TOO_LARGE: "extensions.unpackedTooLarge",
  EXTENSIONS_SIGNATURE_INVALID: "extensions.signatureInvalid",
  EXTENSIONS_MANIFEST_UNSUPPORTED: "extensions.manifestUnsupported",
  EXTENSIONS_CANCELLED: "extensions.cancelled"
};

function extensionFailure(t: Translator, reason: unknown): string {
  const code = typeof reason === "object" && reason !== null && "code" in reason
    ? (reason as { code?: unknown }).code
    : undefined;
  return t(typeof code === "string" ? extensionErrorKeys[code] ?? "extensions.failed" : "extensions.failed");
}

export default function ExtensionsRoute({ roles, t, language, covered = false }: { roles: Role[]; t: Translator; language: AppLanguage; covered?: boolean }) {
  const [snapshot, setSnapshot] = useState<ExtensionSnapshotRecord>({ revision: -1, installed: [], roles: [] });
  const [store, setStore] = useState(emptyStore);
  const [tab, setTab] = useState<"installed" | "store">("installed");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<ExtensionPackageRecord | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const commandBusy = useRef(false);
  const cancellation = useRef<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const previousTab = useRef(tab);
  const previousSelection = useRef(selection);
  const viewport = useRef<HTMLDivElement>(null);

  const pending = useRef<string | null>(null);
  const commandSequence = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    if (previousTab.current === "store" && tab === "installed") addButton.current?.focus();
    previousTab.current = tab;
  }, [tab]);
  useEffect(() => {
    if (previousSelection.current && !selection && document.activeElement === document.body) addButton.current?.focus();
    previousSelection.current = selection;
  }, [selection]);
  const apply = useCallback((next: ExtensionSnapshotRecord) => {
    setSnapshot(previous => next.revision > previous.revision ? next : previous);
  }, []);

  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.rionStudio.onExtensionsChanged(apply);
    const unstore = window.rionStudio.onExtensionStoreChanged(setStore);
    void window.rionStudio.extensions({ type: "snapshot" }).then(r => { if (alive.current) apply(r.snapshot); }, () => { if (alive.current) setError(t("extensions.failed")); });
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
      void window.rionStudio.extensionStore({ action: "show", language, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
        .then(setStore, () => setError(t("extensions.storeUnavailable")));
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); void window.rionStudio.extensionStore({ action: "hide" }).catch(() => undefined); };
  }, [tab, selection, covered, t, language]);

  const command = async (input: ExtensionUserCommand) => {
    if (commandBusy.current) return null;
    commandBusy.current = true;
    const sequence = ++commandSequence.current;
    setBusy(true); setError("");
    try {
      const result = await window.rionStudio.extensions(input);
      if (alive.current) apply(result.snapshot);
      return result;
    } catch (reason) { if (alive.current && sequence === commandSequence.current) setError(extensionFailure(t, reason)); return null; }
    finally { if (sequence === commandSequence.current) { commandBusy.current = false; if (alive.current) setBusy(false); } }
  };
  const close = async () => {
    if (commandBusy.current) return;
    if (pending.current && !await command({ type: "cancel", operationId: pending.current })) return;
    pending.current = null; setOperation(null); setSelection(null); setError("");
  };
  const cancelPreparation = async () => {
    const id = pending.current;
    if (!id || cancelling) return;
    cancellation.current = id;
    commandSequence.current += 1;
    setCancelling(true);
    // Supersede the preparation immediately, but unlock navigation only after Core cancels it.
    try {
      await window.rionStudio.extensions({ type: "cancel", operationId: id });
      pending.current = null; commandBusy.current = false;
      if (alive.current) { setBusy(false); setError(""); }
    } catch { if (alive.current) setError(t("extensions.failed")); }
    finally { if (alive.current) setCancelling(false); }
  };
  const install = async () => {
    const id = store.extensionId;
    if (!id || commandBusy.current) return;
    setError("");
    const existing = snapshot.installed.find(p => p.id === id);
    if (existing) { await window.rionStudio.extensionStore({ action: "hide" }); setSelection(existing); return; }
    const operationId = crypto.randomUUID();
    pending.current = operationId;
    cancellation.current = null;
    const result = await command({ type: "prepare", id, operationId });
    if (!alive.current || pending.current !== operationId || cancellation.current === operationId) return;
    if (result?.prepared) {
      commandBusy.current = true; setBusy(true);
      try { await window.rionStudio.extensionStore({ action: "hide" }); }
      catch { await cancelPreparation(); setError(t("extensions.failed")); return; }
      if (!alive.current || pending.current !== operationId || cancellation.current === operationId) return;
      commandBusy.current = false; setBusy(false);
      setSelection(result.prepared.package); setOperation(operationId);
    } else pending.current = null;
  };
  const save = async (roleIds: string[], applyToAllRoles: boolean, remove: boolean) => {
    if (!selection || commandBusy.current) return;
    const result = await command(remove ? { type: "remove", id: selection.id } : operation
      ? { type: "install", operationId: operation, roleIds, applyToAllRoles }
      : { type: "configure", id: selection.id, roleIds, applyToAllRoles });
    if (result && alive.current) {
      if (operation) { setTab("installed"); setQuery(""); }
      pending.current = null; setOperation(null); setSelection(null);
    }
  };
  const visible = snapshot.installed.filter(p => `${p.name} ${p.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <PageFrame className="h-full" contentClassName="flex h-full min-h-0 min-w-0 w-full flex-col gap-4">
    <PageHeader title={t(tab === "store" ? "extensions.store" : "extensions.title")} description={t("extensions.description")}
      actions={tab === "store" ? <Button className="page-header-control" variant="outline" disabled={busy} onClick={() => setTab("installed")}><ArrowLeft size={14} />{t("extensions.returnToList")}</Button> : <>
        <SearchField className="page-header-control page-header-search" value={query} onChange={setQuery} placeholder={t("extensions.search")} />
        <Button ref={addButton} className="page-header-control" variant="outline" onClick={() => setTab("store")}><Plus size={14} />{t("extensions.add")}</Button>
      </>} />
    {error && !selection && <StatusCallout tone="destructive" role="alert">{error}</StatusCallout>}
    {tab === "store" ? <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" aria-label={t("extensions.back")} disabled={!store.canGoBack} onClick={() => void window.rionStudio.extensionStore({ action: "back" }).then(setStore).catch(() => setError(t("extensions.storeUnavailable")))}><ArrowLeft size={14} /></Button>
        <Button variant="ghost" aria-label={t("extensions.forward")} disabled={!store.canGoForward} onClick={() => void window.rionStudio.extensionStore({ action: "forward" }).then(setStore).catch(() => setError(t("extensions.storeUnavailable")))}><ArrowRight size={14} /></Button>
        <Button variant="ghost" aria-label={t("extensions.reload")} onClick={() => void window.rionStudio.extensionStore({ action: "reload" }).then(setStore).catch(() => setError(t("extensions.storeUnavailable")))}><RefreshCw size={14} /></Button>
        <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{store.failed ? t("extensions.storeUnavailable") : store.url}</span>
        <Button disabled={!store.extensionId || busy || store.loading} onClick={() => void install().catch(() => setError(t("extensions.failed")))}>{busy ? t("extensions.preparing") : snapshot.installed.some(p => p.id === store.extensionId) ? t("extensions.manage") : t("extensions.install")}</Button>
        {busy && pending.current && <Button variant="ghost" disabled={cancelling} onClick={() => void cancelPreparation()}>{t("extensions.cancel")}</Button>}
      </div>
      <div ref={viewport} className="min-h-[240px] min-w-0 w-full flex-1 overflow-x-hidden rounded-md border border-border" aria-label={t("extensions.store")} />
    </div> : snapshot.revision < 0 ? <StatusCallout role="status">{t(error ? "extensions.loadUnavailable" : "extensions.loading")}</StatusCallout>
      : snapshot.installed.length === 0 ? <EmptyState icon={Puzzle} title={t("extensions.empty")} actionLabel={t("extensions.add")} onAction={() => setTab("store")} />
      : visible.length === 0 ? <EmptyState icon={Search} title={t("extensions.noMatches")} actionLabel={t("extensions.clearSearch")} onAction={() => setQuery("")} />
      : <ul className="collection-grid collection-grid-extensions auto-rows-fr gap-3" aria-label={t("extensions.installed")}>
        {visible.map(p => <ExtensionCard key={p.id} language={language} packageRecord={p} runtimeRoles={snapshot.roles} t={t}
          onManage={() => { setError(""); setSelection(p); }} />)}
      </ul>}
    {selection && <ExtensionDialog selection={selection} installing={!!operation} roles={roles} runtimeRoles={snapshot.roles}
      busy={busy} error={error} onClose={() => void close()} onSave={(ids, all, remove) => void save(ids, all, remove)} t={t} />}
  </PageFrame>;
}
