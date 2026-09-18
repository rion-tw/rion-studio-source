import { ArrowLeft, ArrowRight, Plus, Puzzle, Search, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import type { ExtensionPackageRecord, ExtensionSnapshotRecord } from "../../../../shared/generated";
import type { ExtensionStoreState, ExtensionUserCommand } from "../../../../shared/extensions";
import type { AppLanguage, Role } from "../../../../shared/types";
import type { TranslationKey, Translator } from "../../i18n";
import { Button } from "../../components/ui/button";
import { SearchField } from "../../components/SearchField";
import { EmptyState } from "../../components/EmptyState";
import { EditorNotFound } from "../../components/EditorPage";
import { useConfirmation } from "../../components/confirmation";
import { ExtensionCard } from "./ExtensionCard";
import { ExtensionEditor } from "./ExtensionEditor";
import { PageFrame, PageHeader, StatusCallout } from "../../components/ui/patterns";

const emptyStore: ExtensionStoreState = { url: "", extensionId: null, canGoBack: false, canGoForward: false, loading: false, failed: false };
const listPath = "/extensions";
const storePath = "/extensions/store";
const installPath = "/extensions/install";
const editPath = (id: string) => `/extensions/${encodeURIComponent(id)}/edit`;
type View = "installed" | "store" | "install" | "edit";
const resolveView = (pathname: string): View =>
  pathname === storePath ? "store" : pathname === installPath ? "install" : /^\/extensions\/[^/]+\/edit$/.test(pathname) ? "edit" : "installed";

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

interface EditorProps {
  roles: Role[];
  snapshot: ExtensionSnapshotRecord;
  busy: boolean;
  error: string;
  language: AppLanguage;
  t: Translator;
  onSave: (packageRecord: ExtensionPackageRecord, roleIds: string[], applyToAllRoles: boolean, remove: boolean) => Promise<boolean>;
  onRemove: (packageRecord: ExtensionPackageRecord) => Promise<boolean>;
}

function ManageEditor({ roles, snapshot, busy, error, language, t, onSave, onRemove }: EditorProps) {
  const { id } = useParams();
  const navigate = useNavigate();
  const packageRecord = snapshot.installed.find(p => p.id === id);
  if (snapshot.revision < 0) return <PageFrame className="h-full"><StatusCallout role="status">{t(error ? "extensions.loadUnavailable" : "extensions.loading")}</StatusCallout></PageFrame>;
  if (!packageRecord) return <EditorNotFound title={t("editor.notFound.title")} description={t("extensions.notFound")} actionLabel={t("extensions.returnToList")} onAction={() => navigate(listPath, { replace: true })} />;
  return <ExtensionEditor key={packageRecord.id} packageRecord={packageRecord} installing={false} roles={roles} runtimeRoles={snapshot.roles} busy={busy} error={error}
    language={language} t={t} onCancel={() => navigate(listPath, { replace: true })}
    onSave={(ids, all, remove) => onSave(packageRecord, ids, all, remove)} onRemove={() => onRemove(packageRecord)} />;
}

export default function ExtensionsRoute({ roles, t, language, covered = false }: { roles: Role[]; t: Translator; language: AppLanguage; covered?: boolean }) {
  const navigate = useNavigate();
  const confirm = useConfirmation();
  const view = resolveView(useLocation().pathname);
  const [snapshot, setSnapshot] = useState<ExtensionSnapshotRecord>({ revision: -1, installed: [], roles: [] });
  const [store, setStore] = useState(emptyStore);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<{ operationId: string; package: ExtensionPackageRecord } | null>(null);
  const commandBusy = useRef(false);
  const cancellation = useRef<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<string | null>(null);
  const previousView = useRef(view);
  const viewport = useRef<HTMLDivElement>(null);

  const pending = useRef<string | null>(null);
  const commandSequence = useRef(0);
  const alive = useRef(true);
  // The subscription effect must not re-run on a translator identity change:
  // its cleanup cancels the in-flight preparation in Core, so a language switch
  // (or a lazily loaded dictionary resolving) would kill an install that the
  // renderer still shows as pending, leaving a dead operationId behind.
  const translate = useRef(t);
  translate.current = t;
  useEffect(() => {
    if (previousView.current !== "installed" && view === "installed") {
      const card = returnFocus.current ? document.querySelector<HTMLButtonElement>(`[data-extension-id="${returnFocus.current}"] button`) : null;
      (card ?? addButton.current)?.focus();
    }
    if (view === "installed") returnFocus.current = null;
    previousView.current = view;
  }, [view]);
  const apply = useCallback((next: ExtensionSnapshotRecord) => {
    setSnapshot(previous => next.revision > previous.revision ? next : previous);
  }, []);

  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.rionStudio.onExtensionsChanged(apply);
    const unstore = window.rionStudio.onExtensionStoreChanged(setStore);
    void window.rionStudio.extensions({ type: "snapshot" }).then(r => { if (alive.current) apply(r.snapshot); }, () => { if (alive.current) setError(translate.current("extensions.failed")); });
    return () => {
      alive.current = false;
      unsubscribe(); unstore();
      void window.rionStudio.extensionStore({ action: "hide" }).catch(() => undefined);
      if (pending.current) void window.rionStudio.extensions({ type: "cancel", operationId: pending.current }).catch(() => undefined);
    };
  }, [apply]);

  useEffect(() => {
    const element = viewport.current;
    if (view !== "store" || covered || !element) {
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
  }, [view, covered, t, language]);

  /**
   * Releases the latch held by a command this cancellation superseded. The
   * superseded command's own `finally` is fenced out by the sequence bump, so
   * without this the latch would have no owner left to release it.
   */
  const releaseSupersededCommand = () => {
    commandBusy.current = false;
    if (alive.current) setBusy(false);
  };
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
  const closeInstall = async () => {
    if (commandBusy.current) return;
    const operationId = pending.current;
    pending.current = null;
    setError("");
    // Leaving the install editor is the user's decision and must not depend on
    // Core accepting the cancel. This is the editor's only exit -- it backs the
    // header Back action and the Escape key -- so a rejected cancel (a stale or
    // already-terminal operationId) would otherwise trap the user here with no
    // retry affordance. The cancel is still issued, and the route's unmount
    // cleanup re-issues one for any operation still pending.
    if (operationId) {
      void command({ type: "cancel", operationId });
    }
    navigate(storePath, { replace: true });
    setPrepared(null);
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
      // Core acknowledged the cancel, so this is the authoritative terminal for
      // the superseded command even if its own promise never settles.
      pending.current = null;
      releaseSupersededCommand();
      if (alive.current) setError("");
    } catch { if (alive.current) setError(t("extensions.failed")); }
    finally { if (alive.current) setCancelling(false); }
  };
  const install = async () => {
    const id = store.extensionId;
    if (!id || commandBusy.current) return;
    setError("");
    const existing = snapshot.installed.find(p => p.id === id);
    if (existing) { await window.rionStudio.extensionStore({ action: "hide" }); navigate(editPath(existing.id)); return; }
    const operationId = crypto.randomUUID();
    pending.current = operationId;
    cancellation.current = null;
    const result = await command({ type: "prepare", id, operationId });
    if (!alive.current || pending.current !== operationId || cancellation.current === operationId) return;
    if (result?.prepared) {
      commandBusy.current = true; setBusy(true);
      let hidden = false;
      try {
        await window.rionStudio.extensionStore({ action: "hide" });
        hidden = true;
      } catch {
        await cancelPreparation();
        if (alive.current) setError(t("extensions.failed"));
      } finally {
        // This second acquisition is owned here, so every exit releases it --
        // including the superseded return below, which previously left the
        // latch set with no owner and made the whole route inert. The one
        // deliberate exception is a failed cancellation, which retains the
        // latch so the visible Cancel action stays the user's retry path.
        if (hidden || pending.current !== operationId) {
          commandBusy.current = false;
          if (alive.current) setBusy(false);
        }
      }
      if (!hidden || !alive.current) return;
      if (pending.current !== operationId || cancellation.current === operationId) return;
      setPrepared(result.prepared); navigate(installPath);
    } else pending.current = null;
  };
  const save = async (packageRecord: ExtensionPackageRecord, roleIds: string[], applyToAllRoles: boolean, remove: boolean, operation: string | null) => {
    if (commandBusy.current) return false;
    const result = await command(remove ? { type: "remove", id: packageRecord.id } : operation
      ? { type: "install", operationId: operation, roleIds, applyToAllRoles }
      : { type: "configure", id: packageRecord.id, roleIds, applyToAllRoles });
    if (!result || !alive.current) return false;
    if (operation) { setQuery(""); pending.current = null; setPrepared(null); }
    returnFocus.current = packageRecord.id;
    return true;
  };
  const remove = async (packageRecord: ExtensionPackageRecord) => {
    if (commandBusy.current) return false;
    const confirmed = await confirm({
      title: t("extensions.removeTitle").replace("{name}", packageRecord.name), description: t("extensions.removeDescription"),
      cancelLabel: t("extensions.cancel"), confirmLabel: t("extensions.confirmRemove"), tone: "destructive"
    });
    return confirmed && alive.current ? save(packageRecord, [], false, true, null) : false;
  };
  const visible = snapshot.installed.filter(p => `${p.name} ${p.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const catalogue = <PageFrame className="h-full" contentClassName="flex h-full min-h-0 min-w-0 w-full flex-col gap-4">
    <PageHeader title={t(view === "store" ? "extensions.store" : "extensions.title")} description={t("extensions.description")}
      actions={view === "store" ? <Button className="page-header-control" variant="outline" disabled={busy} onClick={() => navigate(listPath)}><ArrowLeft size={14} />{t("extensions.returnToList")}</Button> : <>
        <SearchField className="page-header-control page-header-search" value={query} onChange={setQuery} placeholder={t("extensions.search")} />
        <Button ref={addButton} className="page-header-control" variant="outline" onClick={() => navigate(storePath)}><Plus size={14} />{t("extensions.add")}</Button>
      </>} />
    {error && <StatusCallout tone="destructive" role="alert">{error}</StatusCallout>}
    {view === "store" ? <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-3">
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
      : snapshot.installed.length === 0 ? <EmptyState icon={Puzzle} title={t("extensions.empty")} actionLabel={t("extensions.add")} onAction={() => navigate(storePath)} />
      : visible.length === 0 ? <EmptyState icon={Search} title={t("extensions.noMatches")} actionLabel={t("extensions.clearSearch")} onAction={() => setQuery("")} />
      : <ul className="collection-grid collection-grid-extensions auto-rows-fr gap-3" aria-label={t("extensions.installed")}>
        {visible.map(p => <ExtensionCard key={p.id} language={language} packageRecord={p} runtimeRoles={snapshot.roles} t={t}
          onManage={() => { setError(""); returnFocus.current = p.id; navigate(editPath(p.id)); }} />)}
      </ul>}
  </PageFrame>;
  return <Routes>
    <Route index element={catalogue} />
    <Route path="store" element={catalogue} />
    <Route path="install" element={prepared
      ? <ExtensionEditor key={prepared.operationId} packageRecord={prepared.package} installing roles={roles} runtimeRoles={snapshot.roles} busy={busy} error={error}
        language={language} t={t} onCancel={() => void closeInstall()} onRemove={async () => false}
        onSave={(ids, all) => save(prepared.package, ids, all, false, prepared.operationId)} />
      : <Navigate to={listPath} replace />} />
    <Route path=":id/edit" element={<ManageEditor roles={roles} snapshot={snapshot} busy={busy} error={error} language={language} t={t}
      onSave={(packageRecord, ids, all, remove) => save(packageRecord, ids, all, remove, null)} onRemove={remove} />} />
    <Route path="*" element={<Navigate to={listPath} replace />} />
  </Routes>;
}
