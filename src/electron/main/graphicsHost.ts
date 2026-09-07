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
