import type { CoreEffectRequest } from "../../shared/generated";
import type { ChromiumRuntimeEffectExecutorInput } from "./chromiumRuntimeEffectPorts";
import type { ChromiumRuntimeTabRecord, ChromiumRuntimeRoleRecord, ChromiumRuntimeWebSurfaceRecord } from "./chromiumRuntimeAppKitProjection";
import { requireIdentifier, runtimeError } from "./chromiumRuntimeEffectExecutorSupport";

export function setChromiumRuntimeTabAudioMuted(
    input: { ports: ChromiumRuntimeEffectExecutorInput; tabs: Map<string, ChromiumRuntimeTabRecord>;
      roles: Map<string, ChromiumRuntimeRoleRecord>; webSurfaces: Map<string, ChromiumRuntimeWebSurfaceRecord> },
    effect: CoreEffectRequest,
    action: Extract<CoreEffectRequest["action"], { type: "embeddedSetTabAudioMuted" }>
  ): Readonly<{
    tabId: string;
    windowId: string;
    attemptGeneration: string;
    muted: boolean;
    roles: ReadonlyArray<Readonly<{ roleId: string; ownerGeneration: number }>>;
    webSurfaces: ReadonlyArray<Readonly<{ surfaceId: string; slotId: string }>>;
  }> {
    requireIdentifier(action.tabId, "tab");
    requireIdentifier(action.windowId, "window");
    requireIdentifier(action.attemptGeneration, "attempt generation");
    if (effect.target.handleId !== action.tabId) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_RUNTIME_TARGET_MISMATCH",
        "The Core effect target does not match the audio tab."
      );
    }
    const tab = input.tabs.get(action.tabId);
    if (
      !tab ||
      tab.windowId !== action.windowId ||
      tab.specification.attemptGeneration !== action.attemptGeneration ||
      tab.audioMuted !== action.previousMuted
    ) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_AUDIO_STALE",
        "The Chromium tab audio identity or prior state is stale."
      );
    }
    const expectedRoles = [...action.roles].sort((left, right) =>
      left.roleId.localeCompare(right.roleId)
    );
    const expectedWebSurfaces = [...action.webSurfaces].sort((left, right) =>
      left.surfaceId.localeCompare(right.surfaceId)
    );
    for (const role of expectedRoles) requireIdentifier(role.roleId, "audio role");
    for (const surface of expectedWebSurfaces) {
      requireIdentifier(surface.surfaceId, "audio Web surface");
      requireIdentifier(surface.slotId, "audio Web slot");
    }
    if (
      expectedRoles.length + expectedWebSurfaces.length === 0 ||
      new Set(expectedRoles.map((role) => role.roleId)).size !== expectedRoles.length ||
      new Set(expectedWebSurfaces.map((surface) => surface.surfaceId)).size !==
        expectedWebSurfaces.length ||
      new Set(expectedWebSurfaces.map((surface) => surface.slotId)).size !==
        expectedWebSurfaces.length
    ) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_AUDIO_SURFACE_SET_INVALID",
        "Core supplied an empty or duplicate tab audio surface set."
      );
    }
    const nativeRoles = [...input.roles.values()]
      .filter((role) => role.tabId === action.tabId)
      .sort((left, right) => left.roleId.localeCompare(right.roleId));
    const identitiesMatch = nativeRoles.length === expectedRoles.length &&
      nativeRoles.every((role, index) =>
        role.roleId === expectedRoles[index]?.roleId &&
        role.ownerGeneration === expectedRoles[index]?.ownerGeneration
      );
    if (!identitiesMatch) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_AUDIO_STALE",
        "The Chromium role ownership generation no longer matches Core."
      );
    }
    const nativeWebSurfaces = [...input.webSurfaces.values()]
      .filter((surface) => surface.tabId === action.tabId)
      .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId));
    const webIdentitiesMatch =
      nativeWebSurfaces.length === expectedWebSurfaces.length &&
      nativeWebSurfaces.every((surface, index) =>
        surface.surfaceId === expectedWebSurfaces[index]?.surfaceId &&
        surface.slotId === expectedWebSurfaces[index]?.slotId
      );
    if (!webIdentitiesMatch) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_AUDIO_STALE",
        "The global Web audio surface identity no longer matches Core."
      );
    }
    const previousStates = [
      ...nativeRoles.map((role) => ({
        id: role.roleId,
        generation: role.generation,
        muted: input.ports.surfaces.audioMuted(role.roleId, role.generation),
        set: (muted: boolean) => input.ports.surfaces.setAudioMuted(
          role.roleId,
          role.generation,
          muted
        )
      })),
      ...nativeWebSurfaces.map((surface) => ({
        id: surface.surfaceId,
        generation: surface.generation,
        muted: input.ports.webSurfaces.audioMuted(
          surface.surfaceId,
          surface.generation
        ),
        set: (muted: boolean) => input.ports.webSurfaces.setAudioMuted(
          surface.surfaceId,
          surface.generation,
          muted
        )
      }))
    ];
    if (previousStates.some((record) => record.muted !== action.previousMuted)) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_AUDIO_STATE_DIVERGED",
        "A Chromium role surface no longer matches the Core audio projection."
      );
    }

    const attempted: typeof previousStates = [];
    try {
      for (const record of previousStates) {
        attempted.push(record);
        record.set(action.muted);
      }
    } catch {
      let rollbackFailures = 0;
      for (const record of attempted.reverse()) {
        try {
          record.set(record.muted);
        } catch {
          rollbackFailures += 1;
        }
      }
      throw runtimeError(
        rollbackFailures === 0
          ? "ELECTRON_CHROMIUM_AUDIO_APPLY_FAILED"
          : "BROWSER_RUNTIME_AUDIO_ROLLBACK_FAILED",
        rollbackFailures === 0
          ? "Chromium rejected the tab audio mutation and the prior state was restored."
          : "Chromium tab audio rollback did not restore every exact role surface."
      );
    }
    tab.audioMuted = action.muted;
    return Object.freeze({
      tabId: action.tabId,
      windowId: action.windowId,
      attemptGeneration: action.attemptGeneration,
      muted: action.muted,
      roles: Object.freeze(expectedRoles.map((role) => Object.freeze({ ...role }))),
      webSurfaces: Object.freeze(
        expectedWebSurfaces.map((surface) => Object.freeze({ ...surface }))
      )
    });
  }

