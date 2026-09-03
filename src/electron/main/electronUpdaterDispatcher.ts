import type {
  AppUpdateInstallAttemptRecord,
  AppUpdateStatusRecord
} from "../../shared/generated";
import type {
  RionApiArgs,
  RionApiDispatchMethod,
  RionApiResult
} from "../ipc/apiMethods";
import type { RionApiDispatcher } from "./registerIpcBridge";
import type { RendererIdentity } from "./rendererIdentity";

type MaybePromise<Value> = Value | Promise<Value>;

export interface ElectronUpdaterActions {
  getUpdateStatus: () => MaybePromise<AppUpdateStatusRecord>;
  checkForUpdates: () => Promise<AppUpdateStatusRecord>;
  setAutoUpdateEnabled: (enabled: boolean) => Promise<AppUpdateStatusRecord>;
  installDownloadedUpdate: () => Promise<AppUpdateInstallAttemptRecord>;
}

export function createElectronUpdaterDispatcher(
  updates: ElectronUpdaterActions,
  fallback: RionApiDispatcher
): RionApiDispatcher {
  return {
    async invoke<Method extends RionApiDispatchMethod>(
      identity: RendererIdentity,
      method: Method,
      args: RionApiArgs<Method>
    ): Promise<RionApiResult<Method>> {
      let value: unknown;
      switch (method) {
        case "getUpdateStatus":
          value = await updates.getUpdateStatus();
          break;
        case "checkForUpdates":
          value = await updates.checkForUpdates();
          break;
        case "setAutoUpdateEnabled": {
          const [enabled] = args as unknown as RionApiArgs<"setAutoUpdateEnabled">;
          value = await updates.setAutoUpdateEnabled(enabled);
          break;
        }
        case "installDownloadedUpdate":
          value = await updates.installDownloadedUpdate();
          break;
        default:
          return fallback.invoke(identity, method, args);
      }
      return value as RionApiResult<Method>;
    }
  };
}
