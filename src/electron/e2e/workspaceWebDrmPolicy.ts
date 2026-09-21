import type { CoreAddonClient } from "../core/coreAddonClient";
import type { ChromiumRuntimeBootstrap } from "../main/chromiumRuntimeBootstrap";
import { resolveWorkspaceWebDrmOwner } from "./workspaceWebDrmOwner";
import { readWorkspaceWebSecurityPolicy } from "./workspaceWebSecurityPolicyObserver";

export async function readDrmPolicy(
  windowId: string,
  core: Pick<CoreAddonClient, "invoke"> | null | undefined,
  runtime: Pick<ChromiumRuntimeBootstrap, "snapshot"> | null | undefined,
  owners: Parameters<typeof resolveWorkspaceWebDrmOwner>[3]
) {
  if (process.env.RION_STUDIO_E2E_DRM_DIAGNOSTIC !== "1" || !runtime ||
      runtime.snapshot().roles.filter(role => role.windowId === windowId).length !== 2) return null;
  if (!core) throw new Error("DRM runtime unavailable");
  return readWorkspaceWebSecurityPolicy(resolveWorkspaceWebDrmOwner(windowId,
    (await core.invoke({ type: "appSnapshot" })).browserRuntime.tabs,
    runtime.snapshot().webSurfaces, owners), false);
}
