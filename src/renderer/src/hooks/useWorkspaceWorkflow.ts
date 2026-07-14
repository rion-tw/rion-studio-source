import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { createCopyName } from "../app/copyName";
import { mergeStatuses } from "../app/statusUtils";
import type { WorkspaceFormState } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { WorkspaceDisplaySelectionRequest } from "../features/workspaces/WorkspaceDisplayPickerDialog";
import { runWorkspaceLaunch } from "../features/workspaces/workspaceLaunchUtils";
import type { Translator } from "../i18n";
import type { LaunchWorkspace, RoleStatus, WorkspaceLaunchResult } from "../../../shared/types";

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
  const [displaySelectionRequest, setDisplaySelectionRequest] = useState<WorkspaceDisplaySelectionRequest | null>(null);
  const [query, setQuery] = useState("");
  const displaySelectionResolverRef = useRef<((displayId: number | undefined) => void) | null>(null);
  const launchInProgressRef = useRef(false);
  const listScrollTopRef = useRef(0);

  async function saveWorkspace(form: WorkspaceFormState): Promise<LaunchWorkspace | undefined> {
    setIsSavingWorkspace(true);
    setError(null);

    try {
      const input = {
        name: form.name,
        template: form.template,
        browserZoomPercent: form.browserZoomPercent,
        targetDisplayId: form.targetDisplayId ?? null,
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
        targetDisplayId: workspace.targetDisplayId ?? null,
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
    if (launchInProgressRef.current) {
      return;
    }

    launchInProgressRef.current = true;
    setBusyWorkspaceId(workspace.id);
    setError(null);
    setNotice?.(null);

    try {
      const nextStatuses = await runWorkspaceLaunch({
        launch: (input) => window.rionStudio.launchWorkspace(workspace.id, input),
        selectDisplay: (result) => requestWorkspaceDisplaySelection(workspace, result)
      });
      if (!nextStatuses) {
        return;
      }

      setStatuses((current) => mergeStatuses(current, nextStatuses));
      const notice = nextStatuses.find((status) => status.notice)?.notice;
      if (notice) {
        setNotice?.(notice);
      }
    } catch (launchError) {
      setError(launchError);
      await loadData({ resetError: false });
    } finally {
      settleWorkspaceDisplaySelection(undefined);
      launchInProgressRef.current = false;
      setBusyWorkspaceId(null);
    }
  }

  function requestWorkspaceDisplaySelection(
    workspace: LaunchWorkspace,
    result: Extract<WorkspaceLaunchResult, { kind: "display_selection_required" }>
  ): Promise<number | undefined> {
    return new Promise((resolve) => {
      displaySelectionResolverRef.current = resolve;
      setDisplaySelectionRequest({
        displays: result.displays,
        reason: result.reason,
        workspaceName: workspace.name
      });
    });
  }

  function settleWorkspaceDisplaySelection(displayId: number | undefined): void {
    const resolve = displaySelectionResolverRef.current;
    displaySelectionResolverRef.current = null;
    setDisplaySelectionRequest(null);
    resolve?.(displayId);
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
    displaySelectionRequest,
    handleDisplaySelectionCancel: () => settleWorkspaceDisplaySelection(undefined),
    handleDisplaySelectionSelect: (displayId: number) => settleWorkspaceDisplaySelection(displayId),
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
