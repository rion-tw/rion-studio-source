import type {
  CreateRoleInput,
  ReorderItemsInput,
  Role,
  RoleBrowserSessionSource,
  RolePaths,
  UpdateRoleInput
} from "../../shared/types";
import type { StateRepository } from "../core/RustStateRepository";
import type { AppCoreClient } from "../core/nativeCore";

export class RoleStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RoleStoreError";
  }
}

/** Stateless Electron adapter for the Rust role domain and isolated Chromium directories. */
export class RoleStore {
  constructor(
    _userDataDir: string,
    private readonly stateRepository: StateRepository,
    private readonly core: Pick<AppCoreClient, "invoke" | "resolveRolePaths">
  ) {}

  listRoles(): Promise<Role[]> {
    return this.repository().listRoles();
  }

  getRole(id: string): Promise<Role> {
    return this.repository().getRole(id);
  }

  async createRole(input: CreateRoleInput): Promise<Role> {
    return this.repository().createRole(input);
  }

  updateRole(id: string, input: UpdateRoleInput): Promise<Role> {
    return this.repository().updateRole(id, input);
  }

  reorderRoles(input: ReorderItemsInput): Promise<Role[]> {
    return this.repository().reorderRoles(input.orderedIds);
  }

  async deleteRole(id: string): Promise<void> {
    await this.repository().deleteRole(id);
  }

  updateBrowserSessionSource(id: string, source: RoleBrowserSessionSource): Promise<Role> {
    return this.repository().setRoleBrowserSessionSource(id, source);
  }

  assignGameIds(assignments: ReadonlyMap<string, string>): Promise<Role[]> {
    return this.repository().assignRoleGameIds(assignments);
  }

  getRolePaths(id: string): RolePaths {
    return this.core.resolveRolePaths(id);
  }

  async ensureBrowserUserDataDir(id: string): Promise<string> {
    const paths = await this.core.invoke<RolePaths>({ type: "roleBrowserDirectoryEnsure", id });
    return paths.browserUserDataDir;
  }

  async resetBrowserUserDataDir(id: string): Promise<string> {
    const paths = await this.core.invoke<RolePaths>({ type: "roleBrowserDirectoryReset", id });
    return paths.browserUserDataDir;
  }

  private repository(): StateRepository {
    return this.stateRepository;
  }
}
