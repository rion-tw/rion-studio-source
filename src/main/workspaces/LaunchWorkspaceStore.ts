import type {
  BulkDeleteResult,
  CreateLaunchWorkspaceInput,
  LaunchWorkspace,
  ReorderItemsInput,
  UpdateLaunchWorkspaceInput,
  WorkspaceDisplayInfo,
  WorkspaceSlotBrowserZoomPercent
} from "../../shared/types";
import type { StateRepository } from "../core/RustStateRepository";

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
    private readonly stateRepository: StateRepository
  ) {}

  listWorkspaces(): Promise<LaunchWorkspace[]> {
    return this.repository().listWorkspaces();
  }

  getWorkspace(id: string): Promise<LaunchWorkspace> {
    return this.repository().getWorkspace(id);
  }

  reconcileTargetDisplays(displays: WorkspaceDisplayInfo[]): Promise<LaunchWorkspace[]> {
    return this.repository().reconcileWorkspaceDisplays(displays);
  }

  createWorkspace(input: CreateLaunchWorkspaceInput): Promise<LaunchWorkspace> {
    return this.repository().createWorkspace(input);
  }

  updateWorkspace(id: string, input: UpdateLaunchWorkspaceInput): Promise<LaunchWorkspace> {
    return this.repository().updateWorkspace(id, input);
  }

  updateRoleBrowserZoom(
    workspaceId: string,
    roleId: string,
    browserZoomPercent: WorkspaceSlotBrowserZoomPercent
  ): Promise<LaunchWorkspace | undefined> {
    return this.repository().setWorkspaceRoleBrowserZoom(
      workspaceId,
      roleId,
      browserZoomPercent
    );
  }

  reorderWorkspaces(input: ReorderItemsInput): Promise<LaunchWorkspace[]> {
    return this.repository().reorderWorkspaces(input.orderedIds);
  }

  deleteWorkspace(id: string): Promise<void> {
    return this.repository().deleteWorkspace(id);
  }

  deleteWorkspaces(ids: string[]): Promise<BulkDeleteResult> {
    return this.repository().deleteWorkspaces(ids);
  }

  clearRole(roleId: string): Promise<void> {
    return this.repository().clearWorkspaceRole(roleId);
  }

  private repository(): StateRepository {
    return this.stateRepository;
  }
}
