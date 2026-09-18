import { Check, Puzzle, Save, Trash2 } from "lucide-react";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { ExtensionPackageRecord, ExtensionRoleRecord } from "../../../../shared/generated";
import type { AppLanguage, Role } from "../../../../shared/types";
import { EditorPage } from "../../components/EditorPage";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { StatusCallout, Surface } from "../../components/ui/patterns";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import type { Translator } from "../../i18n";
import { ExtensionRolePicker } from "./ExtensionRolePicker";
import { formatExtensionBytes } from "./extensionSize";

interface Props {
  packageRecord: ExtensionPackageRecord;
  installing: boolean;
  roles: Role[];
  runtimeRoles: ExtensionRoleRecord[];
  busy: boolean;
  error: string;
  language: AppLanguage;
  onCancel: () => void;
  /** Persists the draft (or removes the package) and resolves true when the list may be shown again. */
  onSave: (roleIds: string[], applyToAllRoles: boolean, remove: boolean) => Promise<boolean>;
  /** Asks for removal confirmation and resolves true once Core acknowledged the removal. */
  onRemove: () => Promise<boolean>;
  t: Translator;
}

const sameIds = (left: string[], right: string[]) => left.length === right.length && left.every(id => right.includes(id));

export function ExtensionEditor({ packageRecord, installing, roles, runtimeRoles, busy, error, language, onCancel, onSave, onRemove, t }: Props) {
  const navigate = useNavigate();
  const [allRoles, setAllRoles] = useState(packageRecord.applyToAllRoles);
  const [selectedIds, setSelectedIds] = useState(() => packageRecord.applyToAllRoles ? roles.map(role => role.id) : packageRecord.enabledRoleIds);
  const removed = packageRecord.removed;
  const initial = useRef({ allRoles: packageRecord.applyToAllRoles, selectedIds: packageRecord.applyToAllRoles ? roles.map(role => role.id) : packageRecord.enabledRoleIds });
  const dirty = !installing && !removed && (allRoles !== initial.current.allRoles || (!allRoles && !sameIds(selectedIds, initial.current.selectedIds)));
  const allowLeave = useUnsavedChangesGuard(dirty, useMemo(() => ({
    title: t("confirm.unsaved.title"), description: t("confirm.unsaved.description"),
    cancelLabel: t("confirm.unsaved.continue"), confirmLabel: t("confirm.unsaved.discard"), tone: "destructive" as const
  }), [t]), busy);
  const finish = (done: boolean) => { if (done) { allowLeave(); navigate("/extensions", { replace: true }); } };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    finish(await onSave(selectedIds.filter(id => roles.some(role => role.id === id)), allRoles, removed));
  };
  const remove = async () => { if (!busy) finish(await onRemove()); };
  const size = packageRecord.sizeBytes === undefined ? t("extensions.sizeUnavailable") : formatExtensionBytes(packageRecord.sizeBytes, language);
  const loadFailed = runtimeRoles.some(role => role.extensionIds.includes(packageRecord.id) && (role.status === "failed" || role.status === "indeterminate"));
  const degraded = runtimeRoles.some(role => role.extensionIds.includes(packageRecord.id) && role.status === "degraded");
  const title = t(removed ? "extensions.confirmRemove" : installing ? "extensions.installTitle" : "extensions.manageTitle");
  return <EditorPage
    backActionLabel={t(installing ? "extensions.cancel" : "editor.back")} backLabel={t(installing ? "extensions.cancel" : "extensions.returnToList")}
    description={t(removed ? "extensions.removedDescription" : installing ? "extensions.installDescription" : "extensions.manageDescription")}
    isSaving={busy} onCancel={onCancel} onSubmit={event => void submit(event)}
    saveIcon={removed ? <Trash2 size={16} /> : installing ? <Check size={16} /> : <Save size={16} />}
    saveLabel={t(busy ? "extensions.saving" : removed ? "extensions.confirmRemove" : installing ? "extensions.confirmInstall" : "extensions.save")}
    saveVariant={removed ? "destructive" : "default"} title={title} contentClassName="editor-layout editor-layout-extension">
    <div className="grid min-w-0 gap-4" data-extension-editor={packageRecord.id}>
      {error && <StatusCallout tone="destructive" role="alert">{error}</StatusCallout>}
      {installing && <StatusCallout>{t("extensions.compatibility")}</StatusCallout>}
      {removed ? <StatusCallout tone="warning">{t("extensions.removeDescription")}</StatusCallout>
        : <Surface className="grid gap-3 p-4" variant="inset">
          <ExtensionRolePicker roles={roles} runtimeRoles={runtimeRoles} extensionId={packageRecord.id} selectedIds={selectedIds}
            allRoles={allRoles} busy={busy} onSelectedIds={setSelectedIds} onAllRoles={setAllRoles} t={t} />
        </Surface>}
    </div>
    <div className="grid min-w-0 gap-4">
      <Surface className="grid gap-3 p-4" variant="inset" aria-label={t("extensions.details")}>
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg text-muted-foreground">
            {packageRecord.iconDataUrl ? <img alt="" aria-hidden="true" className="size-full object-contain" decoding="async" draggable={false} src={packageRecord.iconDataUrl} />
              : <Puzzle aria-hidden="true" size={22} />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-heading font-semibold">{packageRecord.name}</h2>
            <p className="mt-0.5 text-caption tabular-nums text-muted-foreground">{packageRecord.version} · {size}</p>
          </div>
        </div>
        {(removed || loadFailed || degraded) && <div className="flex flex-wrap gap-1">
          {removed && <Badge variant="warning">{t("extensions.removalPending")}</Badge>}
          {loadFailed && <Badge variant="destructive">{t("extensions.loadFailed")}</Badge>}
          {degraded && <Badge variant="warning">{t("extensions.compatibilityDegraded")}</Badge>}
        </div>}
        <p className="break-words text-control text-muted-foreground">{packageRecord.description?.trim() || t("extensions.noDescription")}</p>
        <dl className="grid min-w-0 gap-1.5 rounded-md border border-border/35 bg-background/20 px-2.5 py-2 text-caption">
          <div className="flex min-w-0 items-center gap-2">
            <dt className="shrink-0 text-muted-foreground">{t("extensions.id")}</dt>
            <dd className="min-w-0 flex-1 break-all text-right font-mono text-micro text-foreground">{packageRecord.id}</dd>
          </div>
        </dl>
        <details open={installing} className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-control font-medium">{t("extensions.permissions")}</summary>
          {packageRecord.permissions.length ? <ul className="mt-2 grid list-disc gap-1 pl-4 text-caption text-muted-foreground">
            {packageRecord.permissions.map(permission => <li className="break-all" key={permission}>{permission}</li>)}
          </ul> : <p className="mt-2 text-caption text-muted-foreground">{t("extensions.none")}</p>}
        </details>
      </Surface>
      {!installing && !removed && <Surface className="grid gap-3 p-4" variant="inset" aria-label={t("extensions.remove")}>
        <div className="min-w-0">
          <h3 className="text-heading font-semibold">{t("extensions.remove")}</h3>
          <p className="mt-0.5 text-control text-muted-foreground">{t("extensions.removeDescription")}</p>
        </div>
        <Button className="justify-self-start text-destructive" type="button" variant="outline" disabled={busy} onClick={() => void remove()}>
          <Trash2 size={15} />{t("extensions.remove")}
        </Button>
      </Surface>}
    </div>
  </EditorPage>;
}
