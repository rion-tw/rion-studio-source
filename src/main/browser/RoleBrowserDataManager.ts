import type { Session } from "electron";

import type { Role } from "../../shared/types";
import type { RoleStore } from "../roles/RoleStore";
import { createRoleSessionPartition, type BrowserManager } from "./BrowserManager";

const ROLE_STORAGE_DATA_TYPES: NonNullable<Parameters<Session["clearData"]>[0]>["dataTypes"] = [
  "cache",
  "cookies",
  "fileSystems",
  "indexedDB",
  "localStorage",
  "serviceWorkers",
  "webSQL"
];

type RoleDataSession = Pick<Session, "clearData" | "clearStorageData" | "closeAllConnections">;

interface RoleBrowserDataManagerOptions {
  browserManager: Pick<BrowserManager, "stopRoleAndRunRecoverableMutation">;
  getSession: (partition: string) => RoleDataSession;
  roleStore: Pick<
    RoleStore,
    "getRole" | "resetBrowserUserDataDir" | "updateAuthState"
  >;
}

export class RoleBrowserDataClearError extends Error {
  readonly code = "ROLE_BROWSER_DATA_CLEAR_FAILED";

  constructor(readonly failures: unknown[]) {
    super("Some saved browser data could not be cleared.");
    this.name = "RoleBrowserDataClearError";
  }
}

export class RoleBrowserDataManager {
  constructor(private readonly options: RoleBrowserDataManagerOptions) {}

  async clear(roleId: string): Promise<Role> {
    await this.options.roleStore.getRole(roleId);

    return this.options.browserManager.stopRoleAndRunRecoverableMutation(roleId, async () => {
      const [authResult, ...storageResults] = await Promise.allSettled([
        this.options.roleStore.updateAuthState(roleId, "login_required"),
        this.clearEmbeddedData(roleId),
        this.options.roleStore.resetBrowserUserDataDir(roleId)
      ]);
      const storageFailures = storageResults.flatMap(
        (result) => result.status === "rejected" ? [result.reason] : []
      );

      if (authResult.status === "rejected" || storageFailures.length > 0) {
        throw new RoleBrowserDataClearError([
          ...(authResult.status === "rejected" ? [authResult.reason] : []),
          ...storageFailures
        ]);
      }

      return authResult.status === "fulfilled"
        ? authResult.value
        : this.options.roleStore.getRole(roleId);
    });
  }

  private async clearEmbeddedData(roleId: string): Promise<void> {
    const session = this.options.getSession(createRoleSessionPartition(roleId));
    const failures: unknown[] = [];

    await session.closeAllConnections().catch((error) => failures.push(error));
    await session.clearData({ dataTypes: ROLE_STORAGE_DATA_TYPES }).catch((error) => failures.push(error));
    await session.clearStorageData({ storages: ["cachestorage"] }).catch((error) => failures.push(error));

    if (failures.length > 0) {
      throw new AggregateError(failures, "Unable to clear the embedded browser data.");
    }
  }
}
