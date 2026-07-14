import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { createCopyName } from "../app/copyName";
import type { MacroFormState } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { Translator } from "../i18n";
import type { Macro } from "../../../shared/types";
import { DEFAULT_MACRO_LIST_SORT, type MacroListSortState } from "../features/macros/macroListUtils";

interface UseMacroWorkflowOptions {
  loadData: (options?: { resetError?: boolean }) => Promise<void>;
  macros: Macro[];
  setError: (error: unknown | null) => void;
  setMacros: Dispatch<SetStateAction<Macro[]>>;
  t: Translator;
}

export function useMacroWorkflow({
  loadData,
  macros,
  setError,
  setMacros,
  t
}: UseMacroWorkflowOptions) {
  const confirm = useConfirmation();
  const [isSavingMacro, setIsSavingMacro] = useState(false);
  const [busyRunKey, setBusyRunKey] = useState<string | null>(null);
  const [busyMacroId, setBusyMacroId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilterId, setRoleFilterId] = useState("");
  const [sort, setSort] = useState<MacroListSortState>(DEFAULT_MACRO_LIST_SORT);
  const listScrollTopRef = useRef(0);

  async function saveMacro(form: MacroFormState): Promise<Macro | undefined> {
    setIsSavingMacro(true);
    setError(null);

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

      await loadData();
      return savedMacro;
    } catch (submitError) {
      setError(submitError);
      return undefined;
    } finally {
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

    setBusyMacroId(macro.id);
    setError(null);

    try {
      await window.rionStudio.deleteMacro(macro.id);
      await loadData();
    } catch (deleteError) {
      setError(deleteError);
    } finally {
      setBusyMacroId(null);
    }
  }

  async function handleCopyMacro(macro: Macro): Promise<void> {
    setBusyMacroId(macro.id);
    setError(null);

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
      await loadData();
    } catch (copyError) {
      setError(copyError);
    } finally {
      setBusyMacroId(null);
    }
  }

  async function handleStartMacro(macroId: string): Promise<void> {
    setBusyRunKey(macroId);
    setError(null);

    try {
      await window.rionStudio.startMacro(macroId);
    } catch (startError) {
      setError(startError);
      await loadData({ resetError: false });
    } finally {
      setBusyRunKey(null);
    }
  }

  async function handleStopMacro(macroId: string): Promise<void> {
    setBusyRunKey(macroId);
    setError(null);

    try {
      await window.rionStudio.stopMacro(macroId);
      await loadData();
    } catch (stopError) {
      setError(stopError);
    } finally {
      setBusyRunKey(null);
    }
  }

  function resetListState(): void {
    setQuery("");
    setRoleFilterId("");
    setSort(DEFAULT_MACRO_LIST_SORT);
    listScrollTopRef.current = 0;
  }

  return {
    busyMacroId,
    busyRunKey,
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
