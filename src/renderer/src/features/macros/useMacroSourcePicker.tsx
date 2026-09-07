import { useEffect, useRef, useState } from "react";
import type { Macro, Role, RoleStatus } from "../../../../shared/types";
import { allowsMacroChainSource, sourceRoleDependencies } from "../../../../shared/macroExecution";
import type { Translator } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { FormField, Surface } from "../../components/ui/patterns";

type Sources = Record<string, string>;
interface Pending { macros: Macro[]; resolve: (sources: Sources | null) => void }

export function useMacroSourcePicker(macros: Macro[], roles: Role[], statusByRole: ReadonlyMap<string, RoleStatus>, t: Translator) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const [sources, setSources] = useState<Sources>({});
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (pending) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [pending]);
  useEffect(() => () => { pendingRef.current?.resolve(null); pendingRef.current = null; }, []);
  const choices = (macro: Macro) => roles.filter((role) => {
    const status = statusByRole.get(role.id);
    return status?.state === "running" && status.automationState === "ready" && status.pageHealth !== "unresponsive" && allowsMacroChainSource(macros, macro, role.id);
  });
  function settle(result: Sources | null) {
    pendingRef.current?.resolve(result);
    pendingRef.current = null;
    setPending(null);
  }
  function pick(targets: Macro[]): Promise<Sources | null> {
    const dynamic = targets.filter((macro) => sourceRoleDependencies(macros, macro.id).length > 0);
    if (!dynamic.length) return Promise.resolve({});
    if (pendingRef.current) return Promise.resolve(null);
    setSources({});
    return new Promise((resolve) => {
      const next = { macros: dynamic, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }
  const valid = Boolean(pending?.macros.every((macro) => choices(macro).some((role) => role.id === sources[macro.id])));
  const dialog = <dialog ref={dialogRef} aria-labelledby="macro-source-title"
    className="confirmation-dialog m-auto w-[min(480px,calc(100vw-2rem))] max-w-none border-0 bg-transparent p-0 text-foreground"
    onCancel={(event) => { event.preventDefault(); settle(null); }}>
    {pending && <Surface className="grid max-h-[80vh] gap-4 overflow-auto p-5" radius="lg" variant="modal">
      <h2 id="macro-source-title" className="text-title font-semibold">{t("macros.sourcePicker.title")}</h2>
      <p className="text-caption text-muted-foreground">{t("macros.sourcePicker.description")}</p>
      {pending.macros.map((macro) => {
        const available = choices(macro);
        return <FormField key={macro.id} label={macro.name}>
          <Select value={sources[macro.id] ?? ""} onValueChange={(id) => setSources((current) => ({ ...current, [macro.id]: id }))}>
            <SelectTrigger aria-label={macro.name}><SelectValue placeholder={t("macros.sourcePicker.placeholder")} /></SelectTrigger>
            <SelectContent portalContainer={dialogRef.current}>{available.map((role) => <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>)}</SelectContent>
          </Select>
          {!available.length && <p className="text-caption text-warning-foreground">{t("macros.sourcePicker.empty")}</p>}
        </FormField>;
      })}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => settle(null)}>{t("macroForm.cancel")}</Button>
        <Button disabled={!valid} onClick={() => { if (valid) settle(sources); }}>{t("macros.sourcePicker.start")}</Button>
      </div>
    </Surface>}
  </dialog>;
  return { pick, dialog };
}
