import type {
  RionApiArgs,
  RionApiDispatchMethod,
  RionApiResult
} from "../ipc/apiMethods";
import type { RionApiDispatcher } from "./registerIpcBridge";
import type { RendererIdentity } from "./rendererIdentity";

const FONT_MUTATION_METHODS = new Set<RionApiDispatchMethod>([
  "updateGameBrowserSettings",
  "patchGameBrowserSettings",
  "installBrowserFont",
  "installGoogleFont",
  "removeBrowserFont",
  "applyPortableImport"
]);

export interface ChromiumRoleFontRefreshPort {
  refreshRoleFonts: (roleIds: readonly string[]) => Promise<unknown>;
}

/**
 * Makes successful Core font/settings mutations terminal only after every live
 * Chromium role document has acknowledged the exact replacement payload.
 */
export function createChromiumRoleFontApiDispatcher(
  delegate: RionApiDispatcher,
  fonts: ChromiumRoleFontRefreshPort
): RionApiDispatcher {
  return {
    async invoke<Method extends RionApiDispatchMethod>(
      identity: RendererIdentity,
      method: Method,
      args: RionApiArgs<Method>
    ): Promise<RionApiResult<Method>> {
      const result = await delegate.invoke(identity, method, args);
      if (FONT_MUTATION_METHODS.has(method)) {
        await fonts.refreshRoleFonts([]);
      }
      return result;
    }
  };
}
