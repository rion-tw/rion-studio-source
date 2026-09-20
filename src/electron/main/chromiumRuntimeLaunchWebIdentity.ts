import type { CoreAppSnapshotRecord } from "../../shared/generated";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";

interface LaunchWebSurfaceIdentity {
  readonly surfaceId: string;
  readonly slotId: string;
}
type WebSurfaceReconciliation = "invalid" | "pending" | "ready";

function validWebSurfaceIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

export function canonicalWebSurfaceIdentities(
  tab: CoreAppSnapshotRecord["browserRuntime"]["tabs"][number],
  sourceType: "role" | "workspace"
): LaunchWebSurfaceIdentity[] | null {
  if (sourceType === "role" && tab.webSurfaces.length !== 0) return null;
  const surfaceIds = new Set<string>();
  const slotIds = new Set<string>();
  const identities: LaunchWebSurfaceIdentity[] = [];
  for (const surface of tab.webSurfaces) {
    if (
      !validWebSurfaceIdentity(surface.surfaceId) ||
      !validWebSurfaceIdentity(surface.slotId) ||
      surfaceIds.has(surface.surfaceId) ||
      slotIds.has(surface.slotId)
    ) {
      return null;
    }
    surfaceIds.add(surface.surfaceId);
    slotIds.add(surface.slotId);
    identities.push({
      surfaceId: surface.surfaceId,
      slotId: surface.slotId
    });
  }
  return identities.sort((left, right) =>
    left.surfaceId.localeCompare(right.surfaceId) ||
    left.slotId.localeCompare(right.slotId)
  );
}

export function reconcileNativeWebSurfaces(
  expected: readonly LaunchWebSurfaceIdentity[],
  tabId: string,
  windowId: string,
  native: ChromiumRuntimeExecutorSnapshot
): WebSurfaceReconciliation {
  const nativeBySurfaceId = new Map<
    string,
    ChromiumRuntimeExecutorSnapshot["webSurfaces"][number]
  >();
  for (const surface of native.webSurfaces) {
    if (
      !validWebSurfaceIdentity(surface.surfaceId) ||
      !validWebSurfaceIdentity(surface.slotId) ||
      !validWebSurfaceIdentity(surface.tabId) ||
      !validWebSurfaceIdentity(surface.windowId) ||
      !Number.isSafeInteger(surface.generation) ||
      surface.generation < 1 ||
      nativeBySurfaceId.has(surface.surfaceId)
    ) {
      return "invalid";
    }
    nativeBySurfaceId.set(surface.surfaceId, surface);
  }

  const expectedSurfaceIds = new Set(expected.map((surface) => surface.surfaceId));
  if (native.webSurfaces.some((surface) =>
    surface.tabId === tabId && !expectedSurfaceIds.has(surface.surfaceId)
  )) {
    return "invalid";
  }

  let missing = false;
  for (const identity of expected) {
    const surface = nativeBySurfaceId.get(identity.surfaceId);
    if (!surface) {
      missing = true;
      continue;
    }
    if (
      surface.slotId !== identity.slotId ||
      surface.tabId !== tabId ||
      surface.windowId !== windowId
    ) {
      return "invalid";
    }
  }
  return missing ? "pending" : "ready";
}

