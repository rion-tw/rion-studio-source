import type { RionApiArgs, RionApiDispatchMethod, RionApiResult } from "../ipc/apiMethods";
import { graphicsSettingsEqual, isGraphicsSettings } from "../../shared/graphicsSettings";
import { RionBridgeError } from "../ipc/errors";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type { RionApiDispatcher } from "./registerIpcBridge";
import type { RendererIdentity } from "./rendererIdentity";
import type { GraphicsDiagnostics } from "./graphicsDiagnostics";

export function createGraphicsApiDispatcher(
  core: ElectronCoreCommandPort,
  diagnostics: GraphicsDiagnostics,
  restart: (identity: RendererIdentity) => Promise<void>,
  fallback: RionApiDispatcher,
  copyReport: (report: string) => void
): RionApiDispatcher {
  return {
    async invoke<Method extends RionApiDispatchMethod>(identity: RendererIdentity, method: Method,
      args: RionApiArgs<Method>): Promise<RionApiResult<Method>> {
      let result: unknown;
      switch (method) {
        case "getGraphicsSettings": result = await core.invoke({ type: "graphicsSettingsGet" }); break;
        case "updateGraphicsSettings": {
          const [settings] = args;
          if (!isGraphicsSettings(settings)) throw new RionBridgeError({ code: "GRAPHICS_SETTINGS_INVALID", message: "Invalid graphics settings." });
          result = await core.invoke({ type: "graphicsSettingsReplace", settings }); break;
        }
        case "getGraphicsStatus": result = args[0] === true ? await diagnostics.refresh() : diagnostics.snapshot(); break;
        case "copyGraphicsReport": {
          const saved = await core.invoke({ type: "graphicsSettingsGet" });
          const current = diagnostics.snapshot();
          copyReport(JSON.stringify({ saved, pendingRestart: current.appliedSettings !== null &&
            !graphicsSettingsEqual(saved.settings, current.appliedSettings), current }, null, 2));
          break;
        }
        case "restartApplication": result = await restart(identity); break;
        default: return fallback.invoke(identity, method, args);
      }
      return result as RionApiResult<Method>;
    }
  };
}
