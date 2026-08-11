import { useRef, useState } from "react";

import { createCopyName } from "../app/copyName";
import { formatBulkDeleteResult } from "../app/bulkDelete";
import type { WorkspaceFormState } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { Translator } from "../i18n";
import type { LaunchWorkspace, RuntimeLaunchDestination } from "../../../shared/types";
import { useBusyIds } from "./useBusyIds";

interface UseWorkspaceWorkflowOptions {
  beginErrorOperation: () => (error: unknown) => void;
  setNotice?: (message: string | null) => void;
  t: Translator;
  workspaces: LaunchWorkspace[];
}

export function useWorkspaceWorkflow({
  beginErrorOperation,
  setNotice,
  t,
  workspaces
}: UseWorkspaceWorkflowOptions) {
  const confirm = useConfirmation();
  const [isSavingWorkspace, setIsSavingWorkspace] = useState(false);
  const { beginBusy, beginBusyMany, busyIds: busyWorkspaceIds } = useBusyIds();
  const [isReorderingWorkspaces, setIsReorderingWorkspaces] = useState(false);
  const [query, setQuery] = useState("");
  const isReorderingWorkspacesRef = useRef(false);
  const isSavingWorkspaceRef = useRef(false);
  const launchInProgressRef = useRef(false);
  const listScrollTopRef = useRef(0);

  async function saveWorkspace(form: WorkspaceFormState): Promise<LaunchWorkspace | undefined> {
    if (isSavingWorkspaceRef.current) {
      return undefined;
    }

    isSavingWorkspaceRef.current = true;
    setIsSavingWorkspace(true);
    const reportError = beginErrorOperation();

    try {
      const input = {
        name: form.name,
        template: form.template,
        slots: form.slots
      };
      const savedWorkspace = form.id
        ? await window.rionStudio.updateLaunchWorkspace(form.id, input)
        : await window.rionStudio.createLaunchWorkspace(input);

      if (!form.id) {
        setQuery("");
        listScrollTopRef.current = 0;
      }

      return savedWorkspace;
    } catch (submitError) {
      reportError(submitError);
      return undefined;
    } finally {
      isSavingWorkspaceRef.current = false;
      setIsSavingWorkspace(false);
    }
  }

  async function handleDeleteWorkspaces(selectedWorkspaces: LaunchWorkspace[]): Promise<boolean> {
    if (selectedWorkspaces.length === 0) {
      return false;
    }
    const isSingle = selectedWorkspaces.length === 1;
    const confirmed = await confirm({
      title: isSingle
        ? t("confirm.deleteWorkspace.title").replace("{name}", selectedWorkspaces[0].name)
        : t("bulkDelete.workspaces.title").replace("{count}", String(selectedWorkspaces.length)),
      description: isSingle
        ? t("confirm.deleteWorkspace.description")
        : t("bulkDelete.workspaces.description"),
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("confirm.delete"),
      tone: "destructive"
    });

    if (!confirmed) {
      return false;
    }

    const ids = selectedWorkspaces.map((workspace) => workspace.id);
    const finishBusy = beginBusyMany(ids);
    if (!finishBusy) {
      return false;
    }

    const reportError = beginErrorOperation();
    setNotice?.(null);

    try {
      const result = await window.rionStudio.deleteLaunchWorkspaces({ ids });
      setNotice?.(formatBulkDeleteResult(result, t));
      return true;
    } catch (deleteError) {
      reportError(deleteError);
      return false;
    } finally {
      finishBusy();
    }
  }

  async function handleDeleteWorkspace(workspace: LaunchWorkspace): Promise<void> {
    await handleDeleteWorkspaces([workspace]);
  }

  async function handleCopyWorkspace(workspace: LaunchWorkspace): Promise<void> {
    const finishBusy = beginBusy(workspace.id);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();

    try {
      await window.rionStudio.createLaunchWorkspace({
        name: createCopyName(workspace.name, workspaces.map((item) => item.name), t("copyName.suffix")),
        template: workspace.template,
        slots: workspace.slots.map((slot) => ({
          ...slot,
          rect: { ...slot.rect }
        }))
      });
      setQuery("");
      listScrollTopRef.current = 0;
    } catch (copyError) {
      reportError(copyError);
    } finally {
      finishBusy();
    }
  }

  async function handleReorderWorkspaces(orderedIds: string[]): Promise<void> {
    if (isReorderingWorkspacesRef.current) {
      return;
    }

    if (orderedIds.length !== workspaces.length || new Set(orderedIds).size !== workspaces.length) {
      return;
    }

    isReorderingWorkspacesRef.current = true;
    setIsReorderingWorkspaces(true);
    const reportError = beginErrorOperation();
    try {
      await window.rionStudio.reorderLaunchWorkspaces({ orderedIds });
    } catch (reorderError) {
      reportError(reorderError);
    } finally {
      isReorderingWorkspacesRef.current = false;
      setIsReorderingWorkspaces(false);
    }
  }

  async function handleLaunchWorkspace(
    workspace: LaunchWorkspace,
    destination?: RuntimeLaunchDestination
  ): Promise<void> {
    if (launchInProgressRef.current) {
      return;
    }

    launchInProgressRef.current = true;
    const finishBusy = beginBusy(workspace.id);
    if (!finishBusy) {
      launchInProgressRef.current = false;
      return;
    }

    const reportError = beginErrorOperation();
    setNotice?.(null);

    try {
      const result = await window.rionStudio.launchWorkspace(workspace.id, destination);
      const nextStatuses = result.statuses;

      const notice = nextStatuses.find((status) => status.notice)?.notice;
      if (notice) {
        setNotice?.(notice);
      }
    } catch (launchError) {
      reportError(launchError);
    } finally {
      launchInProgressRef.current = false;
      finishBusy();
    }
  }

  return {
    busyWorkspaceIds,
    handleCopyWorkspace,
    handleDeleteWorkspace,
    handleDeleteWorkspaces,
    handleLaunchWorkspace,
    handleReorderWorkspaces,
    isReorderingWorkspaces,
    isSavingWorkspace,
    listScrollTopRef,
    query,
    saveWorkspace,
    setQuery
  };
}
