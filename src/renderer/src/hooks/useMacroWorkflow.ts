import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { createCopyName } from "../app/copyName";
import { formatBulkDeleteResult } from "../app/bulkDelete";
import type { MacroFormState } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { Translator } from "../i18n";
import type { Macro, MacroRunStatus } from "../../../shared/types";
import { DEFAULT_MACRO_LIST_SORT, type MacroListSortState } from "../features/macros/macroListUtils";
import { getMacroPartialStartCounts } from "../features/macros/macroUtils";
import { useBusyIds } from "./useBusyIds";

interface UseMacroWorkflowOptions {
  beginErrorOperation: () => (error: unknown) => void;
  macros: Macro[];
  setMacros: Dispatch<SetStateAction<Macro[]>>;
  setMacroStatuses: Dispatch<SetStateAction<MacroRunStatus[]>>;
  setNotice?: (message: string | null) => void;
  t: Translator;
}

export function useMacroWorkflow({
  beginErrorOperation,
  macros,
  setMacros,
  setMacroStatuses,
  setNotice,
  t
}: UseMacroWorkflowOptions) {
  const confirm = useConfirmation();
  const [isSavingMacro, setIsSavingMacro] = useState(false);
  const { beginBusy, beginBusyMany, busyIds: busyMacroIds } = useBusyIds();
  const busyRunKeys = busyMacroIds;
  const [query, setQuery] = useState("");
  const [roleFilterId, setRoleFilterId] = useState("");
  const [sort, setSort] = useState<MacroListSortState>(DEFAULT_MACRO_LIST_SORT);
  const isSavingMacroRef = useRef(false);
  const listScrollTopRef = useRef(0);

  const openListForRole = useCallback((roleId: string): void => {
    setQuery("");
    setRoleFilterId(roleId);
    listScrollTopRef.current = 0;
  }, []);

  async function saveMacro(form: MacroFormState): Promise<Macro | undefined> {
    if (isSavingMacroRef.current) {
      return undefined;
    }

    isSavingMacroRef.current = true;
    setIsSavingMacro(true);
    const reportError = beginErrorOperation();

    try {
      const input = {
        enabled: form.enabled,
        activationMode: form.activationMode,
        name: form.name,
        roleIds: form.roleIds,
        repeat: form.repeat,
        steps: form.steps,
        trigger: form.trigger ?? null
      };
      const savedMacro = form.id
        ? await window.rionStudio.updateMacro(form.id, input)
        : await window.rionStudio.createMacro(input);

      setMacros((current) => {
        if (form.id) {
          return current.map((macro) => (macro.id === savedMacro.id ? savedMacro : macro));
        }

        return [...current, savedMacro];
      });

      return savedMacro;
    } catch (submitError) {
      reportError(submitError);
      return undefined;
    } finally {
      isSavingMacroRef.current = false;
      setIsSavingMacro(false);
    }
  }

  async function handleDeleteMacros(selectedMacros: Macro[]): Promise<boolean> {
    if (selectedMacros.length === 0) {
      return false;
    }
    const isSingle = selectedMacros.length === 1;
    const confirmed = await confirm({
      title: isSingle
        ? t("confirm.deleteMacro.title").replace("{name}", selectedMacros[0].name)
        : t("bulkDelete.macros.title").replace("{count}", String(selectedMacros.length)),
      description: isSingle ? t("confirm.deleteMacro.description") : t("bulkDelete.macros.description"),
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("confirm.delete"),
      tone: "destructive"
    });

    if (!confirmed) {
      return false;
    }

    const ids = selectedMacros.map((macro) => macro.id);
    const finishBusy = beginBusyMany(ids);
    if (!finishBusy) {
      return false;
    }

    const reportError = beginErrorOperation();
    setNotice?.(null);

    try {
      const result = await window.rionStudio.deleteMacros({ ids });
      const deletedIds = new Set(result.deletedIds);
      setMacros((current) => current.filter((item) => !deletedIds.has(item.id)));
      setMacroStatuses((current) => current.filter((status) => !deletedIds.has(status.macroId)));
      try {
        const [nextMacros, nextStatuses] = await Promise.all([
          window.rionStudio.listMacros(),
          window.rionStudio.listMacroStatuses()
        ]);
        setMacros(nextMacros);
        setMacroStatuses(nextStatuses);
      } catch (recoveryError) {
        reportError(recoveryError);
      }
      setNotice?.(formatBulkDeleteResult(result, t));
      return true;
    } catch (deleteError) {
      reportError(deleteError);
      return false;
    } finally {
      finishBusy();
    }
  }

  async function handleDeleteMacro(macro: Macro): Promise<void> {
    await handleDeleteMacros([macro]);
  }

  async function handleCopyMacro(macro: Macro): Promise<void> {
    const finishBusy = beginBusy(macro.id);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();

    try {
      const copy = await window.rionStudio.createMacro({
        enabled: macro.enabled,
        activationMode: macro.activationMode === "while_held" ? "toggle" : macro.activationMode,
        name: createCopyName(macro.name, macros.map((item) => item.name), t("copyName.suffix")),
        roleIds: [...macro.roleIds],
        repeat: macro.repeat.type === "loop" ? { ...macro.repeat } : { type: "once" },
        steps: macro.steps.map((step) => ({
          ...step,
          ...(step.type === "key" && step.modifiers ? { modifiers: [...step.modifiers] } : {})
        })),
        trigger: null
      });
      setMacros((current) => [...current, copy]);
    } catch (copyError) {
      reportError(copyError);
    } finally {
      finishBusy();
    }
  }

  async function handleStartMacro(macroId: string): Promise<void> {
    const finishBusy = beginBusy(macroId);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();
    setNotice?.(null);

    try {
      const nextStatuses = await window.rionStudio.startMacro(macroId);
      setMacroStatuses((current) => mergeMacroStatuses(current, nextStatuses));
      const partialStart = getMacroPartialStartCounts(
        macros.find((macro) => macro.id === macroId),
        nextStatuses
      );
      if (partialStart) {
        setNotice?.(
          t("macros.partialStartNotice")
            .replace("{started}", String(partialStart.startedCount))
            .replace("{skipped}", String(partialStart.skippedCount))
        );
      }
    } catch (startError) {
      reportError(startError);
      try {
        setMacroStatuses(await window.rionStudio.listMacroStatuses());
      } catch (recoveryError) {
        reportError(recoveryError);
      }
    } finally {
      finishBusy();
    }
  }

  async function handleSetMacroEnabled(macro: Macro, enabled: boolean): Promise<void> {
    if (macro.enabled === enabled) {
      return;
    }

    const finishBusy = beginBusy(macro.id);
    if (!finishBusy) {
      return;
    }
    const reportError = beginErrorOperation();

    try {
      const updated = await window.rionStudio.updateMacro(macro.id, { enabled });
      setMacros((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (!enabled) {
        setMacroStatuses((current) => current.filter((status) => status.macroId !== macro.id));
      }
    } catch (updateError) {
      reportError(updateError);
    } finally {
      finishBusy();
    }
  }

  async function handleStopMacro(macroId: string): Promise<void> {
    const finishBusy = beginBusy(macroId);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();

    try {
      await window.rionStudio.stopMacro(macroId);
      setMacroStatuses((current) => current.filter((status) => status.macroId !== macroId));
    } catch (stopError) {
      reportError(stopError);
    } finally {
      finishBusy();
    }
  }

  function resetListState(): void {
    setQuery("");
    setRoleFilterId("");
    setSort(DEFAULT_MACRO_LIST_SORT);
    listScrollTopRef.current = 0;
  }

  return {
    busyMacroIds,
    busyRunKeys,
    handleCopyMacro,
    handleDeleteMacro,
    handleDeleteMacros,
    handleStartMacro,
    handleSetMacroEnabled,
    handleStopMacro,
    isSavingMacro,
    listScrollTopRef,
    openListForRole,
    query,
    resetListState,
    roleFilterId,
    saveMacro,
    setQuery,
    setRoleFilterId,
    setSort,
    sort
  };
}

function mergeMacroStatuses(current: MacroRunStatus[], next: MacroRunStatus[]): MacroRunStatus[] {
  const nextByKey = new Map(next.map((status) => [`${status.roleId}:${status.macroId}`, status]));
  const merged = current.map((status) => nextByKey.get(`${status.roleId}:${status.macroId}`) ?? status);
  const currentKeys = new Set(current.map((status) => `${status.roleId}:${status.macroId}`));
  return [...merged, ...next.filter((status) => !currentKeys.has(`${status.roleId}:${status.macroId}`))];
}
