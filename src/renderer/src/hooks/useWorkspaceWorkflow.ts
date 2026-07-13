import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";

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
  setStatuses: Dispatch<SetStateAction<RoleStatus[]>>;
  setWorkspaces: Dispatch<SetStateAction<LaunchWorkspace[]>>;
  t: Translator;
  workspaces: LaunchWorkspace[];
}

export function useWorkspaceWorkflow({
  loadData,
  navigateToWorkspaces,
  setError,
  setStatuses,
  setWorkspaces,
  t,
  workspaces
}: UseWorkspaceWorkflowOptions) {
  const [workspaceForm, setWorkspaceForm] = useState<WorkspaceFormState | null>(null);
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [isSavingWorkspace, setIsSavingWorkspace] = useState(false);
  const [busyWorkspaceId, setBusyWorkspaceId] = useState<string | null>(null);

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

  async function handleLaunchWorkspace(workspace: LaunchWorkspace): Promise<void> {
    setBusyWorkspaceId(workspace.id);
    setError(null);

    try {
      const nextStatuses = await window.rionStudio.launchWorkspace(workspace.id);
      setStatuses((current) => mergeStatuses(current, nextStatuses));
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
    handleDeleteWorkspace,
    handleLaunchWorkspace,
    handleStopWorkspace,
    handleWorkspaceSubmit,
    isSavingWorkspace,
    isWorkspaceModalOpen,
    setWorkspaceForm,
    startCreateWorkspace,
    startEditWorkspace,
    workspaceForm
  };
}
