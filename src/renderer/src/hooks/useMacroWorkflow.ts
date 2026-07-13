import { useCallback, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";

import { createCopyName } from "../app/copyName";
import type { MacroFormState } from "../app/types";
import type { Translator } from "../i18n";
import type { Macro, MacroRunStatus, Role } from "../../../shared/types";
import { createClientId, createEmptyMacroFormName, createMacroRunKey } from "../features/macros/macroUtils";

interface UseMacroWorkflowOptions {
  loadData: (options?: { resetError?: boolean }) => Promise<void>;
  macros: Macro[];
  navigateToMacros: () => void;
  roles: Role[];
  setError: (error: unknown | null) => void;
  setMacroStatuses: Dispatch<SetStateAction<MacroRunStatus[]>>;
  setMacros: Dispatch<SetStateAction<Macro[]>>;
  t: Translator;
}

export function useMacroWorkflow({
  loadData,
  macros,
  navigateToMacros,
  roles,
  setError,
  setMacroStatuses,
  setMacros,
  t
}: UseMacroWorkflowOptions) {
  const [macroForm, setMacroForm] = useState<MacroFormState | null>(null);
  const [isMacroModalOpen, setIsMacroModalOpen] = useState(false);
  const [isSavingMacro, setIsSavingMacro] = useState(false);
  const [busyRunKey, setBusyRunKey] = useState<string | null>(null);
  const [busyMacroId, setBusyMacroId] = useState<string | null>(null);

  async function handleMacroSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!macroForm) {
      return;
    }

    setIsSavingMacro(true);
    setError(null);

    try {
      const input = {
        name: macroForm.name,
        roleIds: macroForm.roleIds,
        repeat: macroForm.repeat,
        steps: macroForm.steps,
        trigger: macroForm.trigger ?? null
      };

      if (macroForm.id) {
        const macro = await window.rionStudio.updateMacro(macroForm.id, input);
        setMacros((current) => current.map((item) => (item.id === macro.id ? macro : item)));
      } else {
        const macro = await window.rionStudio.createMacro(input);
        setMacros((current) => [...current, macro]);
      }

      setMacroForm(null);
      setIsMacroModalOpen(false);
      navigateToMacros();
      await loadData();
    } catch (submitError) {
      setError(submitError);
    } finally {
      setIsSavingMacro(false);
    }
  }

  const startCreateMacro = useCallback((requestedRoleId?: string): void => {
    const roleId =
      requestedRoleId && roles.some((role) => role.id === requestedRoleId) ? requestedRoleId : roles[0]?.id ?? "";

    navigateToMacros();
    setMacroForm({
      name: createEmptyMacroFormName(macros, t),
      roleIds: roleId ? [roleId] : [],
      repeat: { type: "once" },
      steps: [
        {
          id: createClientId(),
          type: "key",
          code: "Tab",
          label: "Tab"
        }
      ]
    });
    setIsMacroModalOpen(true);
  }, [macros, navigateToMacros, roles, t]);

  const startEditMacro = useCallback((macro: Macro): void => {
    navigateToMacros();
    setMacroForm({
      id: macro.id,
      name: macro.name,
      roleIds: macro.roleIds,
      repeat: macro.repeat,
      steps: macro.steps,
      trigger: macro.trigger
    });
    setIsMacroModalOpen(true);
  }, [navigateToMacros]);

  function closeMacroModal(): void {
    if (isSavingMacro) {
      return;
    }

    setMacroForm(null);
    setIsMacroModalOpen(false);
  }

  async function handleDeleteMacro(macro: Macro): Promise<void> {
    const confirmed = window.confirm(t("confirm.deleteMacro").replace("{name}", macro.name));

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
        trigger: macro.trigger ? { ...macro.trigger } : null
      });
      setMacros((current) => [...current, copy]);
      navigateToMacros();
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
      const statuses = await window.rionStudio.startMacro(macroId);
      setMacroStatuses((current) => {
        const nextRunKeys = new Set(statuses.map((status) => createMacroRunKey(status.roleId, status.macroId)));
        const next = current.filter((item) => !nextRunKeys.has(createMacroRunKey(item.roleId, item.macroId)));
        return [...next, ...statuses];
      });
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

  return {
    busyMacroId,
    busyRunKey,
    closeMacroModal,
    handleCopyMacro,
    handleDeleteMacro,
    handleMacroSubmit,
    handleStartMacro,
    handleStopMacro,
    isMacroModalOpen,
    isSavingMacro,
    macroForm,
    setMacroForm,
    startCreateMacro,
    startEditMacro
  };
}
