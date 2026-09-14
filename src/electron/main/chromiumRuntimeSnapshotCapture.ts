import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";
import type { ChromiumRuntimeEffectExecutorInput } from "./chromiumRuntimeEffectPorts";
import type { ChromiumRuntimeRoleRecord, ChromiumRuntimeTabRecord,
  ChromiumRuntimeWebSurfaceRecord, ChromiumRuntimeWindowRecord } from "./chromiumRuntimeAppKitProjection";
import { requireIdentifier, sortedSnapshot } from "./chromiumRuntimeEffectExecutorSupport";
interface SnapshotInput {
  windows: ReadonlyMap<string, ChromiumRuntimeWindowRecord>;
  tabs: ReadonlyMap<string, ChromiumRuntimeTabRecord>;
  roles: ReadonlyMap<string, ChromiumRuntimeRoleRecord>;
  webSurfaces: ReadonlyMap<string, ChromiumRuntimeWebSurfaceRecord>;
  closingRoleGenerations: ReadonlyMap<string, number>;
  closingWebSurfaceGenerations: ReadonlyMap<string, number>;
  ports: ChromiumRuntimeEffectExecutorInput;
}
export function captureChromiumRuntimeSnapshot(input: SnapshotInput): ChromiumRuntimeExecutorSnapshot {
    return Object.freeze({
      windows: Object.freeze(sortedSnapshot([...input.windows.entries()].map(
        ([windowId, record]) => {
          const projection = record.host.readProjection();
          return Object.freeze({
            windowId,
            activeTabId: record.activeTabId,
            tabIds: Object.freeze([...record.tabIds]),
            displayId: projection.displayId,
            bounds: Object.freeze({ ...projection.bounds }),
            visible: projection.visible,
            focused: projection.focused,
            presentation: projection.presentation,
            windowGeneration: record.windowGeneration,
            topologyRevision: record.topologyRevision,
            windowZoomFactor: record.windowZoomFactor ?? 1,
            parentNativeHostId: record.host.id,
            ...(record.host.appKitIdentity
              ? { appKitIdentity: Object.freeze({ ...record.host.appKitIdentity }) }
              : {}),
            target: Object.freeze({
              ...record.hostTarget,
              displayId: projection.displayId,
              bounds: Object.freeze({ ...projection.bounds }),
              presentation: projection.presentation
            })
          });
        }
      ))),
      tabs: Object.freeze([...input.tabs.entries()]
        .map(([tabId, record]) => Object.freeze({
          tabId,
          ...(input.windows.get(record.windowId)?.tabIds.includes(tabId) === false
            ? { retiring: true as const } : {}),
          windowId: record.windowId,
          audioMuted: record.audioMuted,
          audible: [...input.roles.values()]
            .filter((role) => role.tabId === tabId &&
              input.closingRoleGenerations.get(role.roleId) !== role.generation)
            .some((role) => input.ports.surfaces.isCurrentlyAudible(
              role.roleId, role.generation)) || [...input.webSurfaces.values()]
            .filter((surface) => surface.tabId === tabId &&
              input.closingWebSurfaceGenerations.get(surface.surfaceId) !==
                surface.generation)
            .some((surface) => input.ports.webSurfaces.isCurrentlyAudible(
              surface.surfaceId, surface.generation)),
          attemptGeneration: requireIdentifier(
            record.specification.attemptGeneration ?? "",
            "tab attempt generation")
        }))
        .sort((left, right) => left.tabId.localeCompare(right.tabId))),
      roles: Object.freeze(sortedSnapshot([...input.roles.values()].map((record) =>
        Object.freeze({
          roleId: record.roleId,
          tabId: record.tabId,
          windowId: record.windowId,
          generation: record.generation,
          ownerGeneration: record.ownerGeneration,
          zoomFactor: record.zoomFactor
        })
      ))),
      webSurfaces: Object.freeze(sortedSnapshot(
        [...input.webSurfaces.values()].map((record) => Object.freeze({
          surfaceId: record.surfaceId,
          slotId: record.slotId,
          tabId: record.tabId,
          windowId: record.windowId,
          generation: record.generation,
          zoomFactor: record.zoomFactor
        }))
      ))
    });
  }


export function requireChromiumRuntimeSnapshot(
  runtime: Pick<import("./chromiumRuntimeBootstrap").ChromiumRuntimeBootstrap, "snapshot"> | null
) {
  if (!runtime) throw new RionBridgeError({
    code: "ELECTRON_CHROMIUM_RUNTIME_UNAVAILABLE",
    message: "The Chromium runtime is unavailable for app snapshot projection."
  });
  return runtime.snapshot();
}
