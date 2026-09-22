import { app, components } from "electron";
import { workspaceWebDrmRuntime } from "./chromiumDrmRuntime";

export function startChromiumDrm(): void {
  workspaceWebDrmRuntime.start(components);
  app.once("will-quit", () => workspaceWebDrmRuntime.stop());
}
