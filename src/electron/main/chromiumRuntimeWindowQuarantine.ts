import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeEffectExecutorInput } from
  "./chromiumRuntimeEffectPorts";
import { reconcileChromiumRuntimeRolePlaceholders } from
  "./chromiumRuntimeRolePlaceholderProjection";
import type {
  ChromiumRuntimeRoleRecord,
  ChromiumRuntimeTabRecord,
  ChromiumRuntimeWebSurfaceRecord,
  ChromiumRuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";

export interface QuarantineChromiumRuntimeWindowsInput {
  readonly ports: ChromiumRuntimeEffectExecutorInput;
  readonly roles: Map<string, ChromiumRuntimeRoleRecord>;
  readonly tabs: Map<string, ChromiumRuntimeTabRecord>;
  readonly webSurfaces: Map<string, ChromiumRuntimeWebSurfaceRecord>;
  readonly windows: Map<string, ChromiumRuntimeWindowRecord>;
  readonly windowIds: readonly string[];
}

function quarantineError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

export async function quarantineChromiumRuntimeWindows(
  input: QuarantineChromiumRuntimeWindowsInput
): Promise<void> {
  const windowIds = [...new Set(input.windowIds)];
  if (windowIds.length !== input.windowIds.length || windowIds.length === 0) {
    throw quarantineError(
      "ELECTRON_MACOS_APPKIT_QUARANTINE_SCOPE_INVALID",
      "The AppKit quarantine scope contains no window or duplicate identities."
    );
  }
  const scopedWindows = windowIds.map((windowId) => {
    const window = input.windows.get(windowId);
    if (!window) {
      throw quarantineError(
        "ELECTRON_MACOS_APPKIT_QUARANTINE_WINDOW_STALE",
        "The AppKit quarantine lost an affected Chromium window."
      );
    }
    return { windowId, window };
  });
  const tabIds = new Set(scopedWindows.flatMap(({ window }) => window.tabIds));
  const ownedRoles = [...input.roles.values()].filter((role) =>
    tabIds.has(role.tabId)
  );
  const ownedWebSurfaces = [...input.webSurfaces.values()].filter((surface) =>
    tabIds.has(surface.tabId)
  );
  const [roleResults, webResults] = await Promise.all([
    Promise.allSettled(ownedRoles.map(async (role) => {
      await input.ports.trustedInput?.retireSurface(
        role.roleId,
        role.generation
      );
      return input.ports.surfaces.closeRole(role.roleId, role.generation);
    })),
    Promise.allSettled(ownedWebSurfaces.map((surface) =>
      input.ports.webSurfaces.closeSurface(surface.surfaceId, surface.generation)
    ))
  ]);
  for (const [index, result] of roleResults.entries()) {
    const role = ownedRoles[index]!;
    if (result.status !== "fulfilled" || result.value !== true) continue;
    input.ports.overlays?.retire(role.roleId, role.generation);
    if (input.roles.get(role.roleId) === role) input.roles.delete(role.roleId);
  }
  for (const [index, result] of webResults.entries()) {
    const surface = ownedWebSurfaces[index]!;
    if (result.status === "fulfilled" && result.value === true &&
      input.webSurfaces.get(surface.surfaceId) === surface) {
      input.webSurfaces.delete(surface.surfaceId);
    }
  }
  const surfaceFailure = [...roleResults, ...webResults].find(
    (result) => result.status === "rejected" || result.value !== true
  );
  if (surfaceFailure) {
    if (surfaceFailure.status === "rejected") throw surfaceFailure.reason;
    throw quarantineError(
      "ELECTRON_MACOS_APPKIT_QUARANTINE_SURFACE_NOT_CLOSED",
      "An affected Chromium surface did not acknowledge exact retirement."
    );
  }

  const hostResults = await Promise.allSettled(
    scopedWindows.map(({ window }) => window.host.close())
  );
  for (const [index, result] of hostResults.entries()) {
    if (result.status !== "fulfilled") continue;
    const { windowId, window } = scopedWindows[index]!;
    for (const tabId of window.tabIds) {
      const tab = input.tabs.get(tabId);
      if (tab?.windowId === windowId) input.tabs.delete(tabId);
    }
    window.tabIds.splice(0, window.tabIds.length);
    if (input.windows.get(windowId) === window) input.windows.delete(windowId);
  }
  let placeholderFailure: unknown;
  try {
    await reconcileChromiumRuntimeRolePlaceholders({
      ports: input.ports,
      tabs: input.tabs,
      windows: input.windows
    });
  } catch (error) {
    placeholderFailure = error;
  }
  const hostFailure = hostResults.find((result) => result.status === "rejected");
  if (hostFailure?.status === "rejected") throw hostFailure.reason;
  if (placeholderFailure !== undefined) throw placeholderFailure;
}
