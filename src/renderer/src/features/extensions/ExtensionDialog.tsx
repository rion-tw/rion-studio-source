import { useEffect, useId, useRef, useState } from "react";
import type { ExtensionPackageRecord, ExtensionRoleRecord } from "../../../../shared/generated";
import type { Role } from "../../../../shared/types";
import { Button } from "../../components/ui/button";
import { DialogLayer, StatusCallout, Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import { ExtensionRolePicker } from "./ExtensionRolePicker";

interface Props {
  selection: ExtensionPackageRecord;
  installing: boolean;
  roles: Role[];
  runtimeRoles: ExtensionRoleRecord[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (roleIds: string[], applyToAllRoles: boolean, remove: boolean) => void;
  t: Translator;
}

export function ExtensionDialog({ selection, installing, roles, runtimeRoles, busy, error, onClose, onSave, t }: Props) {
  const [allRoles, setAllRoles] = useState(selection.applyToAllRoles);
  const [selectedIds, setSelectedIds] = useState(() => selection.applyToAllRoles ? roles.map(role => role.id) : selection.enabledRoleIds);
  const [remove, setRemove] = useState(selection.removed);
  const dialog = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const cancel = () => { if (!busy) { if (remove && !selection.removed) setRemove(false); else onClose(); } };
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { dialog.current?.focus(); }, [remove]);
  const save = () => onSave(selectedIds.filter(id => roles.some(role => role.id === id)), allRoles, remove);
  return <DialogLayer backdropLabel={t("extensions.cancel")} onDismiss={cancel}>
    <Surface variant="modal" className="w-full max-w-xl overflow-hidden">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}
        className="flex max-h-[80vh] flex-col outline-none" onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
          if (event.key !== "Tab") return;
          const targets = [...(dialog.current?.querySelectorAll<HTMLElement>('button,input,summary,[tabindex="0"]') ?? [])]
            .filter(element => !element.matches(':disabled,[aria-disabled="true"]') && !element.closest('fieldset:disabled'));
          const first = targets[0], last = targets.at(-1);
          if (!first) { event.preventDefault(); dialog.current?.focus(); }
          else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}>
        <header className="grid shrink-0 gap-1 border-b border-border px-5 py-4">
          <h2 id={headingId} className="text-title font-semibold">{t(remove ? "extensions.confirmRemove" : installing ? "extensions.installTitle" : "extensions.manageTitle")}</h2>
          <p className="break-words text-body font-medium">{selection.name} <span className="text-caption text-muted-foreground">{selection.version}</span></p>
          <p className="break-all text-caption text-muted-foreground">{selection.id}</p>
        </header>
        <div className="grid min-h-0 gap-4 overflow-y-auto px-5 py-4">
          {remove ? <StatusCallout tone="warning">{t("extensions.removeDescription")}</StatusCallout> : <>
            {installing && <StatusCallout>{t("extensions.compatibility")}</StatusCallout>}
            <details open={installing} className="rounded-md border border-border px-3 py-2">
              <summary className="cursor-pointer text-control font-medium">{t("extensions.permissions")}</summary>
              {selection.permissions.length ? <ul className="mt-2 grid list-disc gap-1 pl-4 text-caption text-muted-foreground">
                {selection.permissions.map(permission => <li className="break-all" key={permission}>{permission}</li>)}
              </ul> : <p className="mt-2 text-caption text-muted-foreground">{t("extensions.none")}</p>}
            </details>
            <ExtensionRolePicker roles={roles} runtimeRoles={runtimeRoles} extensionId={selection.id} selectedIds={selectedIds}
              allRoles={allRoles} busy={busy} onSelectedIds={setSelectedIds} onAllRoles={setAllRoles} t={t} />
          </>}
          {error && <StatusCallout tone="destructive" role="alert">{error}</StatusCallout>}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
          {!installing && !remove && <Button className="mr-auto text-destructive" variant="ghost" disabled={busy} onClick={() => setRemove(true)}>{t("extensions.remove")}</Button>}
          <Button variant="ghost" disabled={busy} onClick={cancel}>{t("extensions.cancel")}</Button>
          <Button disabled={busy} variant={remove ? "destructive" : "default"} onClick={save}>{t(busy ? "extensions.saving" : remove ? "extensions.confirmRemove" : installing ? "extensions.confirmInstall" : "extensions.save")}</Button>
        </footer>
      </div>
    </Surface>
  </DialogLayer>;
}
