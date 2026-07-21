import type { Session } from "electron";

import type { Role } from "../../shared/types";
import type { RoleStore } from "../roles/RoleStore";
import type { BrowserManager } from "./BrowserManager";

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
  getSession: (role: Role) => RoleDataSession;
  roleStore: Pick<
    RoleStore,
    "getRole" | "resetBrowserUserDataDir" | "updateBrowserSessionSource"
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
    const role = await this.options.roleStore.getRole(roleId);

    return this.options.browserManager.stopRoleAndRunRecoverableMutation(roleId, async () => {
      const storageResults = await Promise.allSettled([
        this.clearBrowserData(role),
        this.options.roleStore.resetBrowserUserDataDir(roleId),
        this.options.roleStore.updateBrowserSessionSource(roleId, "embedded")
      ]);
      const storageFailures = storageResults.flatMap(
        (result) => result.status === "rejected" ? [result.reason] : []
      );

      if (storageFailures.length > 0) {
        throw new RoleBrowserDataClearError(storageFailures);
      }

      return this.options.roleStore.getRole(roleId);
    });
  }

  private async clearBrowserData(role: Role): Promise<void> {
    const session = this.options.getSession(role);
    const failures: unknown[] = [];

    await session.closeAllConnections().catch((error) => failures.push(error));
    await session.clearData({ dataTypes: ROLE_STORAGE_DATA_TYPES }).catch((error) => failures.push(error));
    await session.clearStorageData({ storages: ["cachestorage"] }).catch((error) => failures.push(error));

    if (failures.length > 0) {
      throw new AggregateError(failures, "Unable to clear the embedded browser data.");
    }
  }
}
