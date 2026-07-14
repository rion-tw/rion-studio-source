import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { createCopyName } from "../app/copyName";
import { mergeStatuses } from "../app/statusUtils";
import type { WorkspaceFormState } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { WorkspaceDisplaySelectionRequest } from "../features/workspaces/WorkspaceDisplayPickerDialog";
import { runWorkspaceLaunch } from "../features/workspaces/workspaceLaunchUtils";
import type { Translator } from "../i18n";
import type { LaunchWorkspace, Role, RoleStatus, WorkspaceLaunchResult } from "../../../shared/types";
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
  const { beginBusy, busyIds: busyWorkspaceIds } = useBusyIds();
  const [isReorderingWorkspaces, setIsReorderingWorkspaces] = useState(false);
  const [displaySelectionRequest, setDisplaySelectionRequest] = useState<WorkspaceDisplaySelectionRequest | null>(null);
  const [query, setQuery] = useState("");
  const displaySelectionResolverRef = useRef<((displayId: number | undefined) => void) | null>(null);
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

      return savedWorkspace;
    } catch (submitError) {
      reportError(submitError);
      return undefined;
    } finally {
      isSavingWorkspaceRef.current = false;
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

    const finishBusy = beginBusy(workspace.id);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();

    try {
      await window.rionStudio.deleteLaunchWorkspace(workspace.id);
      setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
    } catch (deleteError) {
      reportError(deleteError);
    } finally {
      finishBusy();
    }
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
      settleWorkspaceDisplaySelection(undefined);
      launchInProgressRef.current = false;
      finishBusy();
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
    const finishBusy = beginBusy(workspace.id);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();

    try {
      await window.rionStudio.stopLaunchWorkspace(workspace.id);
      const workspaceRoleIds = new Set(workspace.slots.map((slot) => slot.roleId).filter(Boolean));
      setStatuses((current) => current.filter((status) => !workspaceRoleIds.has(status.roleId)));
    } catch (stopError) {
      reportError(stopError);
    } finally {
      finishBusy();
    }
  }

  return {
    busyWorkspaceIds,
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
