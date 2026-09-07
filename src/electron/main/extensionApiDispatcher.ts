import type { RionApiArgs, RionApiDispatchMethod, RionApiResult } from "../ipc/apiMethods";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type { RionApiDispatcher } from "./registerIpcBridge";
import type { RendererIdentity } from "./rendererIdentity";
import type { ExtensionStoreHost } from "./extensionStoreHost";

export function createExtensionApiDispatcher(core: ElectronCoreCommandPort, store: ExtensionStoreHost, delegate: RionApiDispatcher): RionApiDispatcher {
  return { async invoke<Method extends RionApiDispatchMethod>(identity: RendererIdentity, method: Method, args: RionApiArgs<Method>): Promise<RionApiResult<Method>> {
    if (method === "extensionStore") {
      const [request] = args as unknown as RionApiArgs<"extensionStore">;
      if (!request || !["show", "hide", "back", "forward", "reload"].includes(request.action)) throw new Error("EXTENSIONS_STORE_REQUEST_INVALID");
      return store.request(request) as RionApiResult<Method>;
    }
    if (method === "extensions") {
      const [command] = args as unknown as RionApiArgs<"extensions">;
      if (!command || !["snapshot", "prepare", "cancel", "install", "configure", "remove"].includes(command.type)) throw new Error("EXTENSIONS_COMMAND_FORBIDDEN");
      if (command.type === "prepare" && command.id !== store.snapshot().extensionId) throw new Error("EXTENSIONS_STORE_SELECTION_CHANGED");
      return await core.invoke({ type: "extensions", command }) as RionApiResult<Method>;
    }
    return delegate.invoke(identity, method, args);
  } };
}
