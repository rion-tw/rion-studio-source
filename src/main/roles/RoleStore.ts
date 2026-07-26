import type {
  BulkDeleteResult,
  CreateRoleInput,
  ReorderItemsInput,
  Role,
  RolePaths,
  UpdateRoleInput
} from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";

export class RoleStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RoleStoreError";
  }
}

/** Stateless shell adapter for the Rust role domain and isolated System WebView directories. */
export class RoleStore {
  constructor(
    _userDataDir: string,
    private readonly core: Pick<AppCoreClient, "invoke">
  ) {}

  listRoles(): Promise<Role[]> {
    return this.core.invoke({ type: "rolesList" });
  }

  getRole(id: string): Promise<Role> {
    return this.core.invoke({ type: "roleGet", id });
  }

  async createRole(input: CreateRoleInput): Promise<Role> {
    return this.core.invoke({
      type: "roleCreate",
      input: {
        gameId: input.gameId,
        name: input.name,
        ...(input.launchUrl === undefined ? {} : { launchUrl: input.launchUrl }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(typeof input.coverImageDataUrl === "string"
          ? { coverImageDataUrl: input.coverImageDataUrl }
          : {}),
        ...(typeof input.coverImageDominantColor === "string"
          ? { coverImageDominantColor: input.coverImageDominantColor }
          : {})
      }
    });
  }

  updateRole(id: string, input: UpdateRoleInput): Promise<Role> {
    return this.core.invoke({
      type: "roleUpdate",
      id,
      input: {
        ...(input.gameId === undefined ? {} : { gameId: input.gameId }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.launchUrl === undefined ? {} : { launchUrl: input.launchUrl }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(typeof input.coverImageDataUrl === "string"
          ? { coverImageDataUrl: input.coverImageDataUrl }
          : {}),
        setCoverImageDataUrl: input.coverImageDataUrl !== undefined,
        ...(typeof input.coverImageDominantColor === "string"
          ? { coverImageDominantColor: input.coverImageDominantColor }
          : {}),
        setCoverImageDominantColor: input.coverImageDominantColor !== undefined
      }
    });
  }

  reorderRoles(input: ReorderItemsInput): Promise<Role[]> {
    return this.core.invoke({ type: "roleReorder", orderedIds: input.orderedIds });
  }

  async deleteRole(id: string): Promise<void> {
    await this.core.invoke({ type: "roleDelete", id });
  }

  deleteRoles(ids: string[]): Promise<BulkDeleteResult> {
    return this.core.invoke({ type: "rolesDelete", ids });
  }

  assignGameIds(assignments: ReadonlyMap<string, string>): Promise<Role[]> {
    return this.core.invoke({
      type: "roleAssignGameIds",
      assignments: [...assignments].map(([roleId, gameId]) => ({ roleId, gameId }))
    });
  }

  getRolePaths(id: string): Promise<RolePaths> {
    return this.core.invoke({ type: "rolePathsResolve", id });
  }

}
