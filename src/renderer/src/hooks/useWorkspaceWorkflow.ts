import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { createCopyName } from "../app/copyName";
import { formatBulkDeleteResult } from "../app/bulkDelete";
import { mergeStatuses } from "../app/statusUtils";
import type { WorkspaceFormState } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { Translator } from "../i18n";
import type { LaunchWorkspace, Role, RoleStatus } from "../../../shared/types";
import { useBusyIds } from "./useBusyIds";

interface UseWorkspaceWorkflowOptions {
  beginErrorOperation: () => (error: unknown) => void;
  setNotice?: (message: string | null) => void;
  setRoles: Dispatch<SetStateAction<Role[]>>;
  setStatuses: Dispatch<SetStateAction<RoleStatus[]>>;
  setWorkspaces: Dispatch<SetStateAction<LaunchWorkspace[]>>;
  t: Translator;
  workspaces: LaunchWorkspace[];
}

export function useWorkspaceWorkflow({
  beginErrorOperation,
  setNotice,
  setRoles,
  setStatuses,
  setWorkspaces,
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

      setWorkspaces((current) => {
        if (form.id) {
          return current.map((workspace) => (workspace.id === savedWorkspace.id ? savedWorkspace : workspace));
        }

        return [...current, savedWorkspace];
      });

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
      const deletedIds = new Set(result.deletedIds);
      setWorkspaces((current) => current.filter((item) => !deletedIds.has(item.id)));
      try {
        const [nextWorkspaces, nextStatuses] = await Promise.all([
          window.rionStudio.listLaunchWorkspaces(),
          window.rionStudio.listRoleStatuses()
        ]);
        setWorkspaces(nextWorkspaces);
        setStatuses(nextStatuses);
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
      const copy = await window.rionStudio.createLaunchWorkspace({
        name: createCopyName(workspace.name, workspaces.map((item) => item.name), t("copyName.suffix")),
        template: workspace.template,
        slots: workspace.slots.map((slot) => ({
          ...slot,
          rect: { ...slot.rect }
        }))
      });
      setWorkspaces((current) => [...current, copy]);
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

    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const nextWorkspaces = orderedIds
      .map((id) => workspaceById.get(id))
      .filter((workspace): workspace is LaunchWorkspace => Boolean(workspace));

    if (nextWorkspaces.length !== workspaces.length) {
      return;
    }

    isReorderingWorkspacesRef.current = true;
    setIsReorderingWorkspaces(true);
    const reportError = beginErrorOperation();
    setWorkspaces(nextWorkspaces);

    try {
      const savedWorkspaces = await window.rionStudio.reorderLaunchWorkspaces({ orderedIds });
      setWorkspaces(savedWorkspaces);
    } catch (reorderError) {
      reportError(reorderError);
      try {
        setWorkspaces(await window.rionStudio.listLaunchWorkspaces());
      } catch (recoveryError) {
        reportError(recoveryError);
      }
    } finally {
      isReorderingWorkspacesRef.current = false;
      setIsReorderingWorkspaces(false);
    }
  }

  async function handleLaunchWorkspace(workspace: LaunchWorkspace): Promise<void> {
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
      const result = await window.rionStudio.launchWorkspace(workspace.id);
      const nextStatuses = result.statuses;

      setStatuses((current) => mergeStatuses(current, nextStatuses));
      const notice = nextStatuses.find((status) => status.notice)?.notice;
      if (notice) {
        setNotice?.(notice);
      }
    } catch (launchError) {
      reportError(launchError);
      try {
        const [nextRoles, nextStatuses] = await Promise.all([
          window.rionStudio.listRoles(),
          window.rionStudio.listRoleStatuses()
        ]);
        setRoles(nextRoles);
        setStatuses(nextStatuses);
      } catch (recoveryError) {
        reportError(recoveryError);
      }
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
