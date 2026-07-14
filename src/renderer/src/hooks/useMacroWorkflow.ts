import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { createCopyName } from "../app/copyName";
import type { MacroFormState } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { Translator } from "../i18n";
import type { Macro } from "../../../shared/types";
import { DEFAULT_MACRO_LIST_SORT, type MacroListSortState } from "../features/macros/macroListUtils";
import { useBusyIds } from "./useBusyIds";

interface UseMacroWorkflowOptions {
  beginErrorOperation: () => (error: unknown) => void;
  loadData: (options?: { resetError?: boolean }) => Promise<void>;
  macros: Macro[];
  setMacros: Dispatch<SetStateAction<Macro[]>>;
  t: Translator;
}

export function useMacroWorkflow({
  beginErrorOperation,
  loadData,
  macros,
  setMacros,
  t
}: UseMacroWorkflowOptions) {
  const confirm = useConfirmation();
  const [isSavingMacro, setIsSavingMacro] = useState(false);
  const { beginBusy, busyIds: busyMacroIds } = useBusyIds();
  const busyRunKeys = busyMacroIds;
  const [query, setQuery] = useState("");
  const [roleFilterId, setRoleFilterId] = useState("");
  const [sort, setSort] = useState<MacroListSortState>(DEFAULT_MACRO_LIST_SORT);
  const isSavingMacroRef = useRef(false);
  const listScrollTopRef = useRef(0);

  async function saveMacro(form: MacroFormState): Promise<Macro | undefined> {
    if (isSavingMacroRef.current) {
      return undefined;
    }

    isSavingMacroRef.current = true;
    setIsSavingMacro(true);
    const reportError = beginErrorOperation();

    try {
      const input = {
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

      if (!form.id) {
        resetListState();
      }

      await loadData({ resetError: false });
      return savedMacro;
    } catch (submitError) {
      reportError(submitError);
      return undefined;
    } finally {
      isSavingMacroRef.current = false;
      setIsSavingMacro(false);
    }
  }

  async function handleDeleteMacro(macro: Macro): Promise<void> {
    const confirmed = await confirm({
      title: t("confirm.deleteMacro.title").replace("{name}", macro.name),
      description: t("confirm.deleteMacro.description"),
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("confirm.delete"),
      tone: "destructive"
    });

    if (!confirmed) {
      return;
    }

    const finishBusy = beginBusy(macro.id);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();

    try {
      await window.rionStudio.deleteMacro(macro.id);
      await loadData({ resetError: false });
    } catch (deleteError) {
      reportError(deleteError);
    } finally {
      finishBusy();
    }
  }

  async function handleCopyMacro(macro: Macro): Promise<void> {
    const finishBusy = beginBusy(macro.id);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();

    try {
      const copy = await window.rionStudio.createMacro({
        name: createCopyName(macro.name, macros.map((item) => item.name), t("copyName.suffix")),
        roleIds: [...macro.roleIds],
        repeat: macro.repeat.type === "loop" ? { ...macro.repeat } : { type: "once" },
        steps: macro.steps.map((step) => ({ ...step })),
        trigger: null
      });
      setMacros((current) => [...current, copy]);
      resetListState();
      await loadData({ resetError: false });
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

    try {
      await window.rionStudio.startMacro(macroId);
    } catch (startError) {
      reportError(startError);
      await loadData({ resetError: false });
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
      await loadData({ resetError: false });
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
    handleStartMacro,
    handleStopMacro,
    isSavingMacro,
    listScrollTopRef,
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
