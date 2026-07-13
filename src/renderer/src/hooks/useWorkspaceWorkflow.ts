import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";

import { createCopyName } from "../app/copyName";
import { mergeStatuses } from "../app/statusUtils";
import type { WorkspaceFormState } from "../app/types";
import type { Translator } from "../i18n";
import {
  applyWorkspaceTemplate,
  createWorkspaceFormState,
  createWorkspaceName
} from "../features/workspaces/workspaceLayoutUtils";
import {
  DEFAULT_WORKSPACE_TEMPLATE,
  getDefaultWorkspaceBrowserZoomPercent
} from "../../../shared/workspaceLayout";
import type { LaunchWorkspace, RoleStatus } from "../../../shared/types";

interface UseWorkspaceWorkflowOptions {
  loadData: (options?: { resetError?: boolean }) => Promise<void>;
  navigateToWorkspaces: () => void;
  setError: (error: unknown | null) => void;
  setNotice?: (message: string | null) => void;
  setStatuses: Dispatch<SetStateAction<RoleStatus[]>>;
  setWorkspaces: Dispatch<SetStateAction<LaunchWorkspace[]>>;
  t: Translator;
  workspaces: LaunchWorkspace[];
}

export function useWorkspaceWorkflow({
  loadData,
  navigateToWorkspaces,
  setError,
  setNotice,
  setStatuses,
  setWorkspaces,
  t,
  workspaces
}: UseWorkspaceWorkflowOptions) {
  const [workspaceForm, setWorkspaceForm] = useState<WorkspaceFormState | null>(null);
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [isSavingWorkspace, setIsSavingWorkspace] = useState(false);
  const [busyWorkspaceId, setBusyWorkspaceId] = useState<string | null>(null);
  const [isReorderingWorkspaces, setIsReorderingWorkspaces] = useState(false);

  async function handleWorkspaceSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!workspaceForm) {
      return;
    }

    setIsSavingWorkspace(true);
    setError(null);

    try {
      if (workspaceForm.id) {
        const workspace = await window.rionStudio.updateLaunchWorkspace(workspaceForm.id, {
          name: workspaceForm.name,
          template: workspaceForm.template,
          browserZoomPercent: workspaceForm.browserZoomPercent,
          slots: workspaceForm.slots
        });
        setWorkspaces((current) => current.map((item) => (item.id === workspace.id ? workspace : item)));
      } else {
        const workspace = await window.rionStudio.createLaunchWorkspace({
          name: workspaceForm.name,
          template: workspaceForm.template,
          browserZoomPercent: workspaceForm.browserZoomPercent,
          slots: workspaceForm.slots
        });
        setWorkspaces((current) => [...current, workspace]);
      }

      setWorkspaceForm(null);
      setIsWorkspaceModalOpen(false);
      navigateToWorkspaces();
      await loadData();
    } catch (submitError) {
      setError(submitError);
    } finally {
      setIsSavingWorkspace(false);
    }
  }

  function startCreateWorkspace(): void {
    navigateToWorkspaces();
    setWorkspaceForm({
      name: createWorkspaceName(workspaces, t),
      template: DEFAULT_WORKSPACE_TEMPLATE,
      browserZoomPercent: getDefaultWorkspaceBrowserZoomPercent(DEFAULT_WORKSPACE_TEMPLATE),
      slots: applyWorkspaceTemplate([], DEFAULT_WORKSPACE_TEMPLATE)
    });
    setIsWorkspaceModalOpen(true);
  }

  function startEditWorkspace(workspace: LaunchWorkspace): void {
    navigateToWorkspaces();
    setWorkspaceForm(createWorkspaceFormState(workspace));
    setIsWorkspaceModalOpen(true);
  }

  function closeWorkspaceModal(): void {
    if (isSavingWorkspace) {
      return;
    }

    setWorkspaceForm(null);
    setIsWorkspaceModalOpen(false);
  }

  async function handleDeleteWorkspace(workspace: LaunchWorkspace): Promise<void> {
    const confirmed = window.confirm(t("confirm.deleteWorkspace").replace("{name}", workspace.name));

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
      navigateToWorkspaces();
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
    closeWorkspaceModal,
    handleCopyWorkspace,
    handleDeleteWorkspace,
    handleLaunchWorkspace,
    handleReorderWorkspaces,
    handleStopWorkspace,
    handleWorkspaceSubmit,
    isSavingWorkspace,
    isReorderingWorkspaces,
    isWorkspaceModalOpen,
    setWorkspaceForm,
    startCreateWorkspace,
    startEditWorkspace,
    workspaceForm
  };
}
