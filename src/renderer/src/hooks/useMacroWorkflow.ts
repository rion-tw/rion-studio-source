import { useCallback, useRef, useState } from "react";

import { createCopyName } from "../app/copyName";
import { formatBulkDeleteResult } from "../app/bulkDelete";
import type { MacroFormState } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { Translator } from "../i18n";
import type { Macro } from "../../../shared/types";
import {
  DEFAULT_MACRO_LIST_SORT,
  type MacroListSortState,
  type MacroListViewMode
} from "../features/macros/macroListUtils";
import { getMacroPartialStartCounts } from "../features/macros/macroUtils";
import { useBusyIds } from "./useBusyIds";

interface UseMacroWorkflowOptions {
  beginErrorOperation: () => (error: unknown) => void;
  macros: Macro[];
  runtimeInputAvailable?: boolean;
  setNotice?: (message: string | null) => void;
  t: Translator;
}

export function useMacroWorkflow({
  beginErrorOperation,
  macros,
  runtimeInputAvailable = true,
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
  const [viewMode, setViewMode] = useState<MacroListViewMode>("grouped");
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [focusedMacroId, setFocusedMacroId] = useState<string | null>(null);
  const isSavingMacroRef = useRef(false);
  const listScrollTopRef = useRef(0);

  const openListForRole = useCallback((roleId: string): void => {
    setQuery("");
    setRoleFilterId(roleId);
    listScrollTopRef.current = 0;
  }, []);

  const openListForMacro = useCallback((macroId: string): void => {
    setQuery("");
    setRoleFilterId("");
    setCollapsedGroupKeys(new Set());
    setFocusedMacroId(macroId);
    listScrollTopRef.current = 0;
  }, []);

  const toggleMacroGroup = useCallback((groupKey: string): void => {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
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
        shortcutSourceScope: form.shortcutSourceScope,
        repeat: form.repeat,
        steps: form.steps,
        trigger: form.trigger ?? null
      };
      const savedMacro = form.id
        ? await window.rionStudio.updateMacro(form.id, input)
        : await window.rionStudio.createMacro(input);

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
      await window.rionStudio.createMacro({
        enabled: macro.enabled,
        activationMode: macro.activationMode === "while_held" ? "toggle" : macro.activationMode,
        name: createCopyName(macro.name, macros.map((item) => item.name), t("copyName.suffix")),
        roleIds: [...macro.roleIds],
        shortcutSourceScope: { type: "all_execution_roles" },
        repeat: macro.repeat.type === "loop" ? { ...macro.repeat } : { type: "once" },
        steps: macro.steps.map((step) => ({
          ...step,
          ...(step.type === "key" && step.modifiers ? { modifiers: [...step.modifiers] } : {})
        })),
        trigger: null
      });
      resetListState();
    } catch (copyError) {
      reportError(copyError);
    } finally {
      finishBusy();
    }
  }

  async function handleStartMacros(selectedMacros: Macro[]): Promise<boolean> {
    const targets = uniqueMacros(selectedMacros);
    if (targets.length === 0) {
      return false;
    }
    if (!runtimeInputAvailable) {
      const reportError = beginErrorOperation();
      reportError({
        code: "MACRO_RUNTIME_NOT_ACTIVE",
        message: t("macros.runtimeNotActive")
      });
      return false;
    }

    const finishBusy = beginBusyMany(targets.map((macro) => macro.id));
    if (!finishBusy) {
      return false;
    }

    const reportError = beginErrorOperation();
    setNotice?.(null);

    try {
      const results = await Promise.allSettled(
        targets.map((macro) => window.rionStudio.startMacro(macro.id))
      );
      const successful = results.flatMap((result, index) =>
        result.status === "fulfilled"
          ? [{ macro: targets[index], statuses: result.value }]
          : []
      );
      const partialStart = successful.reduce(
        (total, { macro, statuses }) => {
          const partial = getMacroPartialStartCounts(macro, statuses);
          return partial
            ? {
                skippedCount: total.skippedCount + partial.skippedCount,
                startedCount: total.startedCount + partial.startedCount
              }
            : total;
        },
        { skippedCount: 0, startedCount: 0 }
      );
      if (partialStart.skippedCount > 0) {
        setNotice?.(
          t("macros.partialStartNotice")
            .replace("{started}", String(partialStart.startedCount))
            .replace("{skipped}", String(partialStart.skippedCount))
        );
      }

      reportMacroOperationFailures(successful.length, results, reportError, setNotice, t);
      return successful.length > 0;
    } finally {
      finishBusy();
    }
  }

  async function handleStartMacro(macroId: string): Promise<boolean> {
    const macro = macros.find((candidate) => candidate.id === macroId);
    if (macro) {
      return handleStartMacros([macro]);
    }
    return false;
  }

  async function handleSetMacrosEnabled(selectedMacros: Macro[], enabled: boolean): Promise<void> {
    const targets = uniqueMacros(selectedMacros).filter((macro) => macro.enabled !== enabled);
    if (targets.length === 0) {
      return;
    }

    const finishBusy = beginBusyMany(targets.map((macro) => macro.id));
    if (!finishBusy) {
      return;
    }
    const reportError = beginErrorOperation();
    setNotice?.(null);

    try {
      const results = await Promise.allSettled(
        targets.map((macro) => window.rionStudio.updateMacro(macro.id, { enabled }))
      );
      const updatedMacros = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      );
      reportMacroOperationFailures(updatedMacros.length, results, reportError, setNotice, t);
    } finally {
      finishBusy();
    }
  }

  async function handleSetMacroEnabled(macro: Macro, enabled: boolean): Promise<void> {
    await handleSetMacrosEnabled([macro], enabled);
  }

  async function handleStopMacros(selectedMacros: Macro[]): Promise<void> {
    const targets = uniqueMacros(selectedMacros);
    if (targets.length === 0) {
      return;
    }

    const finishBusy = beginBusyMany(targets.map((macro) => macro.id));
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();
    setNotice?.(null);

    try {
      const results = await Promise.allSettled(
        targets.map((macro) => window.rionStudio.stopMacro(macro.id))
      );
      const stoppedIds = new Set(results.flatMap((result, index) =>
        result.status === "fulfilled" ? [targets[index].id] : []
      ));

      reportMacroOperationFailures(stoppedIds.size, results, reportError, setNotice, t);
    } finally {
      finishBusy();
    }
  }

  async function handleStopMacro(macroId: string): Promise<void> {
    const macro = macros.find((candidate) => candidate.id === macroId);
    if (macro) {
      await handleStopMacros([macro]);
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
    collapsedGroupKeys,
    focusedMacroId,
    handleCopyMacro,
    handleDeleteMacro,
    handleDeleteMacros,
    handleStartMacro,
    handleStartMacros,
    handleSetMacroEnabled,
    handleSetMacrosEnabled,
    handleStopMacro,
    handleStopMacros,
    isSavingMacro,
    listScrollTopRef,
    openListForRole,
    openListForMacro,
    query,
    resetListState,
    roleFilterId,
    saveMacro,
    setQuery,
    setFocusedMacroId,
    setRoleFilterId,
    setSort,
    setViewMode,
    sort,
    toggleMacroGroup,
    viewMode
  };
}

function uniqueMacros(macros: Macro[]): Macro[] {
  return [...new Map(macros.map((macro) => [macro.id, macro])).values()];
}

function reportMacroOperationFailures(
  succeededCount: number,
  results: PromiseSettledResult<unknown>[],
  reportError: (error: unknown) => void,
  setNotice: ((message: string | null) => void) | undefined,
  t: Translator
): void {
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failures.length === 0) {
    return;
  }
  if (results.length === 1) {
    reportError(failures[0].reason);
    return;
  }

  const message = t("macros.bulk.partialFailure")
    .replace("{succeeded}", String(succeededCount))
    .replace("{failed}", String(failures.length));
  setNotice?.(message);
  reportError(new Error(message));
}
