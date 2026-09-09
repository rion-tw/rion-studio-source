import type { LoadedRionNodeAddon } from "./electronCoreBootstrap";
import type { RendererIdentity } from "./rendererIdentity";
import type { RionIpcBridgeRegistration } from "./registerIpcBridge";
import { release } from "node:os";
import type { App } from "electron";
import type { CoreAddonClient } from "../core/coreAddonClient";
import type { GraphicsSettingsSnapshotRecord, GraphicsStatusRecord } from "../../shared/generated";
import { applyGraphicsStartup } from "./graphicsStartup";
import { GraphicsDiagnostics } from "./graphicsDiagnostics";

export class GraphicsHost {
  readonly diagnostics: GraphicsDiagnostics;
  #unsubscribe: (() => void) | null = null;
  constructor(app: App, read: () => string, platform: "darwin" | "win32",
    publishStatus: (status: GraphicsStatusRecord) => void,
    private readonly publishSettings: (snapshot: GraphicsSettingsSnapshotRecord) => void) {
    const applied = applyGraphicsStartup(app, read, platform);
    this.diagnostics = new GraphicsDiagnostics(app, applied, {
      os: `${platform} ${release()}`, rion: app.getVersion(),
      electron: process.versions.electron, chromium: process.versions.chrome
    }, publishStatus);
  }
  attach(core: CoreAddonClient): void {
    this.#unsubscribe = core.subscribeCoreEvents((event) => {
      if (event.type === "graphicsSettingsChanged") this.publishSettings(event.snapshot);
    });
  }
  dispose(): void { this.#unsubscribe?.(); this.diagnostics.dispose(); }
}

export function createGraphicsHost(
  app: App,
  addon: Pick<LoadedRionNodeAddon, "readGraphicsSettingsAtStartup">,
  userDataDirectory: string,
  platform: "darwin" | "win32",
  target: () => { identity: RendererIdentity; bridge: RionIpcBridgeRegistration } | null
): GraphicsHost {
  return new GraphicsHost(app,
    () => addon.readGraphicsSettingsAtStartup(userDataDirectory), platform,
    (status) => {
      const current = target();
      current?.bridge.publish(current.identity, "onGraphicsStatusChanged", status);
    },
    (snapshot) => {
      const current = target();
      current?.bridge.publish(current.identity, "onGraphicsSettingsChanged", snapshot);
    });
}
