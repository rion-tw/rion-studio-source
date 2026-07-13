import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { createCopyName } from "../app/copyName";
import { mergeStatuses } from "../app/statusUtils";
import type { WorkspaceFormState } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { Translator } from "../i18n";
import type { LaunchWorkspace, RoleStatus } from "../../../shared/types";

interface UseWorkspaceWorkflowOptions {
  loadData: (options?: { resetError?: boolean }) => Promise<void>;
  setError: (error: unknown | null) => void;
  setNotice?: (message: string | null) => void;
  setStatuses: Dispatch<SetStateAction<RoleStatus[]>>;
  setWorkspaces: Dispatch<SetStateAction<LaunchWorkspace[]>>;
  t: Translator;
  workspaces: LaunchWorkspace[];
}

export function useWorkspaceWorkflow({
  loadData,
  setError,
  setNotice,
  setStatuses,
  setWorkspaces,
  t,
  workspaces
}: UseWorkspaceWorkflowOptions) {
  const confirm = useConfirmation();
  const [isSavingWorkspace, setIsSavingWorkspace] = useState(false);
  const [busyWorkspaceId, setBusyWorkspaceId] = useState<string | null>(null);
  const [isReorderingWorkspaces, setIsReorderingWorkspaces] = useState(false);
  const [query, setQuery] = useState("");
  const listScrollTopRef = useRef(0);

  async function saveWorkspace(form: WorkspaceFormState): Promise<LaunchWorkspace | undefined> {
    setIsSavingWorkspace(true);
    setError(null);

    try {
      const input = {
        name: form.name,
        template: form.template,
        browserZoomPercent: form.browserZoomPercent,
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

      await loadData();
      return savedWorkspace;
    } catch (submitError) {
      setError(submitError);
      return undefined;
    } finally {
      setIsSavingWorkspace(false);
    }
  }

  async function handleDeleteWorkspace(workspace: LaunchWorkspace): Promise<void> {
    const confirmed = await confirm({
      title: t("confirm.deleteWorkspace.title").replace("{name}", workspace.name),
      description: t("confirm.deleteWorkspace.description"),
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("confirm.delete"),
      tone: "destructive"
    });

    if (!confirmed) {
      return;
    }

    setBusyWorkspaceId(workspace.id);
    setError(null);

    try {
      await window.rionStudio.deleteLaunchWorkspace(workspace.id);
      await loadData();
    } catch (deleteError) {
      setError(deleteError);
    } finally {
      setBusyWorkspaceId(null);
    }
  }

  async function handleCopyWorkspace(workspace: LaunchWorkspace): Promise<void> {
    setBusyWorkspaceId(workspace.id);
    setError(null);

    try {
      const copy = await window.rionStudio.createLaunchWorkspace({
        name: createCopyName(workspace.name, workspaces.map((item) => item.name), t("copyName.suffix")),
        template: workspace.template,
        browserZoomPercent: workspace.browserZoomPercent,
        slots: workspace.slots.map((slot) => ({
          ...slot,
          rect: { ...slot.rect }
        }))
      });
      setWorkspaces((current) => [...current, copy]);
      setQuery("");
      listScrollTopRef.current = 0;
      await loadData();
    } catch (copyError) {
      setError(copyError);
    } finally {
      setBusyWorkspaceId(null);
    }
  }

  async function handleReorderWorkspaces(orderedIds: string[]): Promise<void> {
    if (isReorderingWorkspaces) {
      return;
    }

    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const nextWorkspaces = orderedIds
      .map((id) => workspaceById.get(id))
      .filter((workspace): workspace is LaunchWorkspace => Boolean(workspace));

    if (nextWorkspaces.length !== workspaces.length) {
      return;
    }

    setIsReorderingWorkspaces(true);
    setError(null);
    setWorkspaces(nextWorkspaces);

    try {
      const savedWorkspaces = await window.rionStudio.reorderLaunchWorkspaces({ orderedIds });
      setWorkspaces(savedWorkspaces);
    } catch (reorderError) {
      setError(reorderError);
      await loadData({ resetError: false });
    } finally {
      setIsReorderingWorkspaces(false);
    }
  }

  async function handleLaunchWorkspace(workspace: LaunchWorkspace): Promise<void> {
    setBusyWorkspaceId(workspace.id);
    setError(null);
    setNotice?.(null);

    try {
      const nextStatuses = await window.rionStudio.launchWorkspace(workspace.id);
      setStatuses((current) => mergeStatuses(current, nextStatuses));
      const notice = nextStatuses.find((status) => status.notice)?.notice;
      if (notice) {
        setNotice?.(notice);
      }
    } catch (launchError) {
      setError(launchError);
      await loadData({ resetError: false });
    } finally {
      setBusyWorkspaceId(null);
    }
  }

  async function handleStopWorkspace(workspace: LaunchWorkspace): Promise<void> {
    setBusyWorkspaceId(workspace.id);
    setError(null);

    try {
      await window.rionStudio.stopLaunchWorkspace(workspace.id);
      const workspaceRoleIds = new Set(workspace.slots.map((slot) => slot.roleId).filter(Boolean));
      setStatuses((current) => current.filter((status) => !workspaceRoleIds.has(status.roleId)));
    } catch (stopError) {
      setError(stopError);
    } finally {
      setBusyWorkspaceId(null);
    }
  }

  return {
    busyWorkspaceId,
    handleCopyWorkspace,
    handleDeleteWorkspace,
    handleLaunchWorkspace,
    handleReorderWorkspaces,
    handleStopWorkspace,
    isReorderingWorkspaces,
    isSavingWorkspace,
    listScrollTopRef,
    query,
    saveWorkspace,
    setQuery
  };
}
