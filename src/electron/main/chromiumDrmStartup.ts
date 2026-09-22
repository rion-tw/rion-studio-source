import { app } from "electron";
import * as electron from "electron";
import { workspaceWebDrmRuntime, type DrmComponentsPort } from "./chromiumDrmRuntime";

export function startChromiumDrm(): void {
  workspaceWebDrmRuntime.start((electron as typeof electron & { components?: DrmComponentsPort }).components);
  app.once("will-quit", () => workspaceWebDrmRuntime.stop());
}
