import type {
  BulkDeleteResult,
  CreateLaunchWorkspaceInput,
  LaunchWorkspace,
  ReorderItemsInput,
  UpdateLaunchWorkspaceInput,
  WorkspaceDisplayInfo,
  WorkspaceSlotBrowserZoomPercent
} from "../../shared/types";
import type { WorkspaceDisplayInfoRecord } from "../../shared/generated";
import {
  toWorkspaceCreateInput,
  toWorkspaceUpdateInput
} from "../core/domainInputs";
import type { AppCoreClient } from "../core/nativeCore";

export const LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION = 7;

export class LaunchWorkspaceStoreError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "LaunchWorkspaceStoreError";
  }
}

/**
 * Typed main-process client for the Rust workspace domain.
 * Electron display discovery stays in TypeScript; all reconciliation and mutation
 * decisions are performed transactionally by rion-core.
 */
export class LaunchWorkspaceStore {
  constructor(
    _userDataDir: string,
    private readonly core: Pick<AppCoreClient, "invoke">
  ) {}

  listWorkspaces(): Promise<LaunchWorkspace[]> {
    return this.core.invoke({ type: "workspacesList" });
  }

  getWorkspace(id: string): Promise<LaunchWorkspace> {
    return this.core.invoke({ type: "workspaceGet", id });
  }

  reconcileTargetDisplays(displays: WorkspaceDisplayInfo[]): Promise<LaunchWorkspace[]> {
    return this.core.invoke({
      type: "workspaceReconcileDisplays",
      displays: displays.map((display): WorkspaceDisplayInfoRecord => ({
        id: display.id,
        label: display.label,
        bounds: { ...display.bounds },
        resolution: { ...display.resolution },
        scaleFactor: display.scaleFactor,
        isPrimary: display.isPrimary,
        isInternal: display.isInternal
      }))
    });
  }

  createWorkspace(input: CreateLaunchWorkspaceInput): Promise<LaunchWorkspace> {
    return this.core.invoke({
      type: "workspaceCreate",
      input: toWorkspaceCreateInput(input)
    });
  }

  updateWorkspace(id: string, input: UpdateLaunchWorkspaceInput): Promise<LaunchWorkspace> {
    return this.core.invoke({
      type: "workspaceUpdate",
      id,
      input: toWorkspaceUpdateInput(input)
    });
  }

  updateRoleBrowserZoom(
    workspaceId: string,
    roleId: string,
    browserZoomPercent: WorkspaceSlotBrowserZoomPercent
  ): Promise<LaunchWorkspace | undefined> {
    return this.core.invoke({
      type: "workspaceSetRoleBrowserZoom",
      workspaceId,
      roleId,
      browserZoomPercent
    }).then((workspace) => workspace ?? undefined);
  }

  reorderWorkspaces(input: ReorderItemsInput): Promise<LaunchWorkspace[]> {
    return this.core.invoke({ type: "workspaceReorder", orderedIds: input.orderedIds });
  }

  deleteWorkspace(id: string): Promise<void> {
    return this.core.invoke({ type: "workspaceDelete", id }).then(() => undefined);
  }

  deleteWorkspaces(ids: string[]): Promise<BulkDeleteResult> {
    return this.core.invoke({ type: "workspacesDelete", ids });
  }

  clearRole(roleId: string): Promise<void> {
    return this.core.invoke({ type: "workspaceClearRole", roleId }).then(() => undefined);
  }
}
