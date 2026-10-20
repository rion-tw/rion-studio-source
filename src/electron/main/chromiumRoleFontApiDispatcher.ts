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

// A document replaced or closed during the refresh never shows the old
// payload again; its replacement installs the committed settings itself.
const SUPERSEDED_REFRESH_CODES = new Set([
  "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED",
  "ELECTRON_ROLE_FONT_SURFACE_RETIRED"
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
        await fonts.refreshRoleFonts([]).catch((error: unknown) => {
          if (!SUPERSEDED_REFRESH_CODES.has(errorCode(error))) throw error;
        });
      }
      return result;
    }
  };
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : "";
}
