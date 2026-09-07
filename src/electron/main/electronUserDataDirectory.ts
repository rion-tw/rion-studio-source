import { isAbsolute, join } from "node:path";
import type { App } from "electron";
import { RionBridgeError } from "../ipc/errors";

export function sharedUserDataDirectory(app: Pick<App, "isPackaged" | "getPath">, appName: string): string {
  const override = process.env.RION_STUDIO_USER_DATA_DIR;
  if (override) {
    if (app.isPackaged) {
      throw new RionBridgeError({
        code: "ELECTRON_USER_DATA_OVERRIDE_FORBIDDEN",
        message: "The user-data override is restricted to development builds."
      });
    }
    if (!isAbsolute(override)) {
      throw new RionBridgeError({
        code: "ELECTRON_USER_DATA_PATH_INVALID",
        message: "RION_STUDIO_USER_DATA_DIR must be an absolute path."
      });
    }
    return override;
  }
  return join(app.getPath("appData"), appName);
}
