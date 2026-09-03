import type {
  BrowserRuntimeRoleRecord,
  CoreEffectRequest,
  EmbeddedLaunchTargetRecord,
  EmbeddedRuntimeWindowProjectionRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import {
  coreEffectEventContinuation,
  type CoreEffectEventContinuation
} from "./coreEffectContinuation";
import type { ChromiumRuntimeEffectExecutorInput } from
  "./chromiumRuntimeEffectExecutor";
import type {
  ChromiumRuntimeRoleRecord,
  ChromiumRuntimeTabRecord,
  ChromiumRuntimeWebSurfaceRecord,
  ChromiumRuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";
import { applyChromiumRuntimeWindowSurfaceVisibility } from
  "./chromiumRuntimeWindowVisibility";
import { quarantineChromiumRuntimeWindows } from
  "./chromiumRuntimeWindowQuarantine";
import { applyChromiumRuntimeWindowsProjection } from
  "./chromiumRuntimeWindowsProjection";
import type {
  ChromiumRuntimeOwnershipTransitionCoordinator,
  ChromiumRuntimeOwnershipTransitionReceipt
} from "./chromiumRuntimeOwnershipTransitionCoordinator";

interface FollowChromiumRuntimeOwnershipInput {
  readonly effect: CoreEffectRequest;
  readonly lifecycleEpoch: number;
  readonly projectedRoles: readonly BrowserRuntimeRoleRecord[];
  readonly projectedWindows: readonly EmbeddedRuntimeWindowProjectionRecord[];
  readonly target?: EmbeddedLaunchTargetRecord;
  readonly revealWindowIds: readonly string[];
  readonly focusWindowIds: readonly string[];
  readonly focusTabId?: string;
  readonly ownershipTransitions: ChromiumRuntimeOwnershipTransitionCoordinator;
  readonly signal?: AbortSignal;
  readonly beforeNativeSubmission: () => Promise<void>;
  readonly ports: ChromiumRuntimeEffectExecutorInput;
  readonly windows: Map<string, ChromiumRuntimeWindowRecord>;
  readonly tabs: Map<string, ChromiumRuntimeTabRecord>;
  readonly roles: Map<string, ChromiumRuntimeRoleRecord>;
  readonly webSurfaces: Map<string, ChromiumRuntimeWebSurfaceRecord>;
}

function ownershipError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value === value.trim() &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function sameBounds(
  left: EmbeddedLaunchTargetRecord["bounds"],
  right: EmbeddedLaunchTargetRecord["bounds"]
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function exactEmptyHostProjection(
  host: ChromiumRuntimeWindowRecord["host"],
  target: EmbeddedLaunchTargetRecord
): boolean {
  const projection = host.readProjection();
  return host.logicalWindowId === target.windowId &&
    projection.displayId === target.displayId &&
    projection.presentation === target.presentation &&
    sameBounds(projection.bounds, target.bounds) &&
    !projection.visible && !projection.focused;
}

function applyAppKitOwnershipFences(
  input: FollowChromiumRuntimeOwnershipInput
): void {
  const appKitWindows = [...input.windows.values()].filter(
    (window) => window.host.appKitIdentity !== undefined
  );
  if (appKitWindows.length === 0) return;
  const transitionWindowIds = new Set([
    ...input.revealWindowIds,
    ...input.focusWindowIds
  ]);
  const projectionsByWindow = new Map<string, EmbeddedRuntimeWindowProjectionRecord[]>();
  for (const projection of input.projectedWindows) {
    const projections = projectionsByWindow.get(projection.windowId) ?? [];
    projections.push(projection);
    projectionsByWindow.set(projection.windowId, projections);
  }
  for (const current of appKitWindows) {
    const projections = projectionsByWindow.get(current.host.logicalWindowId) ?? [];
    if (projections.length === 0) {
      throw ownershipError(
        "ELECTRON_MACOS_APPKIT_PHASE_PROJECTION_INCOMPLETE",
        "Core omitted a live AppKit host from its phase projection."
      );
    }
    if (projections.length !== 1) {
      throw ownershipError(
        "ELECTRON_MACOS_APPKIT_PHASE_PROJECTION_INVALID",
        "Core duplicated a live AppKit host in its phase projection."
      );
    }
    const projection = projections[0]!;
    const projectionWasSuperseded =
      projection.topologyRevision < current.topologyRevision;
    if (
      projectionWasSuperseded &&
      !transitionWindowIds.has(current.host.logicalWindowId)
    ) {
      continue;
    }
    if (
      projection.windowGeneration !== current.windowGeneration ||
      projectionWasSuperseded ||
      JSON.stringify(projection.tabIds) !== JSON.stringify(current.tabIds) ||
      projection.hiddenTabIds.length !== current.hiddenTabIds.size ||
      projection.hiddenTabIds.some((tabId) => !current.hiddenTabIds.has(tabId)) ||
      (projection.activeTabId ?? "") !== current.activeTabId
    ) {
      throw ownershipError(
        "ELECTRON_MACOS_APPKIT_OWNERSHIP_FENCE_STALE",
        "Core supplied a stale AppKit Role-ownership window fence."
      );
    }
    if (!current.host.applyAppKitPhaseProjection) {
      throw ownershipError(
        "ELECTRON_MACOS_APPKIT_PHASE_PROJECTION_UNAVAILABLE",
        "The retained AppKit host cannot consume Core activation phases."
      );
    }
    current.host.applyAppKitPhaseProjection(projection);
    current.topologyRevision = projection.topologyRevision;
  }
}

async function provisionEmptySavedWindow(
  input: FollowChromiumRuntimeOwnershipInput
): Promise<ChromiumRuntimeWindowRecord | null> {
  const { effect, target } = input;
  if (!target || input.windows.has(target.windowId)) return null;
  const projection = input.projectedWindows.find(
    (candidate) => candidate.windowId === target.windowId
  );
  if (!projection || projection.tabIds.length > 0) return null;
  if (
    effect.target.kind !== "app" || effect.target.handleId !== "embedded-runtime" ||
    effect.completionPolicy !== "eventBound" || effect.deadlineMs !== undefined ||
    !validIdentifier(effect.effectId) || !validIdentifier(target.windowId) ||
    projection.hiddenTabIds.length !== 0 || projection.activeTabId !== undefined ||
    !Number.isSafeInteger(projection.windowGeneration) ||
    projection.windowGeneration < 1 ||
    !Number.isSafeInteger(projection.topologyRevision) ||
    projection.topologyRevision < 1 ||
    !input.revealWindowIds.includes(target.windowId) ||
    !input.focusWindowIds.includes(target.windowId)
  ) {
    throw ownershipError(
      "ELECTRON_CHROMIUM_EMPTY_SAVED_WINDOW_EFFECT_INVALID",
      "Core supplied a malformed or non-event-bound empty saved-window projection."
    );
  }
  const host = await input.ports.hosts.createEmpty(target, {
    attemptGeneration: effect.effectId,
    windowGeneration: projection.windowGeneration,
    topologyRevision: projection.topologyRevision
  });
  const appKitIdentity = host.appKitIdentity;
  if (
    host.isDestroyed() || !Number.isSafeInteger(host.id) || host.id < 1 ||
    !exactEmptyHostProjection(host, target) ||
    (appKitIdentity !== undefined && (
      appKitIdentity.logicalWindowId !== target.windowId ||
      appKitIdentity.launchGeneration !== effect.effectId ||
      !Number.isSafeInteger(appKitIdentity.nativeGeneration) ||
      appKitIdentity.nativeGeneration < 1
    ))
  ) {
    if (!host.isDestroyed()) await host.close();
    throw ownershipError(
      "ELECTRON_CHROMIUM_EMPTY_SAVED_WINDOW_HOST_INVALID",
      "The empty saved Game Window did not return an exact hidden native-host receipt."
    );
  }
  const record: ChromiumRuntimeWindowRecord = {
    host,
    hostTarget: { ...target, bounds: { ...target.bounds }, workArea: { ...target.workArea } },
    tabIds: [],
    hiddenTabIds: new Set(),
    activeTabId: "",
    windowGeneration: projection.windowGeneration,
    topologyRevision: projection.topologyRevision,
    lastAdapterSequence: 0,
    windowZoomFactor: 1
  };
  input.windows.set(target.windowId, record);
  return record;
}

async function compensateEmptySavedWindow(
  input: FollowChromiumRuntimeOwnershipInput,
  record: ChromiumRuntimeWindowRecord
): Promise<void> {
  try {
    if (!record.host.isDestroyed()) await record.host.close();
  } catch {
    throw ownershipError(
      "ELECTRON_CHROMIUM_EMPTY_SAVED_WINDOW_COMPENSATION_FAILED",
      "The failed empty saved-window transaction left an unknown native host."
    );
  }
  if (!record.host.isDestroyed()) {
    throw ownershipError(
      "ELECTRON_CHROMIUM_EMPTY_SAVED_WINDOW_COMPENSATION_FAILED",
      "The failed empty saved-window transaction did not destroy its exact native host."
    );
  }
  if (input.windows.get(record.host.logicalWindowId) === record) {
    input.windows.delete(record.host.logicalWindowId);
  }
}

export async function followChromiumRuntimeOwnership(
  input: FollowChromiumRuntimeOwnershipInput
): Promise<CoreEffectEventContinuation | undefined> {
  const seenRoles = new Set<string>();
  for (const role of input.projectedRoles) {
    if (!validIdentifier(role.roleId) || seenRoles.has(role.roleId)) {
      throw ownershipError(
        "ELECTRON_CHROMIUM_ROLE_SET_INVALID",
        "Core supplied an invalid or duplicate role ownership record."
      );
    }
    seenRoles.add(role.roleId);
    const native = input.roles.get(role.roleId);
    if (native && native.tabId !== role.owner.tabId) {
      throw ownershipError(
        "ELECTRON_CHROMIUM_ROLE_OWNERSHIP_DIVERGED",
        "The native Chromium surface no longer matches Core role ownership."
      );
    }
  }
  const quarantineWindows = (windowIds: readonly string[]) =>
    quarantineChromiumRuntimeWindows({
      ports: input.ports,
      roles: input.roles,
      tabs: input.tabs,
      webSurfaces: input.webSurfaces,
      windows: input.windows,
      windowIds
    });
  const provisioned = await provisionEmptySavedWindow(input);
  let continuation:
    CoreEffectEventContinuation<ChromiumRuntimeOwnershipTransitionReceipt> | undefined;
  try {
    await applyChromiumRuntimeWindowsProjection({
      projections: input.projectedWindows,
      ports: input.ports,
      windows: input.windows,
      tabs: input.tabs,
      roles: input.roles,
      webSurfaces: input.webSurfaces,
      quarantineWindows
    });
    applyAppKitOwnershipFences(input);
    if (input.focusTabId) {
      const tab = input.tabs.get(input.focusTabId);
      if (!tab) {
        throw ownershipError(
          "ELECTRON_CHROMIUM_FOCUS_TAB_NOT_FOUND",
          "Core selected a native focus tab that is not attached."
        );
      }
      input.windows.get(tab.windowId)!.activeTabId = input.focusTabId;
    }
    if (
      new Set(input.revealWindowIds).size !== input.revealWindowIds.length ||
      new Set(input.focusWindowIds).size !== input.focusWindowIds.length ||
      input.focusWindowIds.length > 1 ||
      input.focusWindowIds.some((windowId) => !input.revealWindowIds.includes(windowId))
    ) {
      throw ownershipError(
        "ELECTRON_CHROMIUM_FOCUS_INTENT_INVALID",
        "Core supplied duplicate reveal targets or an invalid process-global focus target."
      );
    }
    const focusWindowId = input.focusWindowIds[0];
    if (input.focusTabId) {
      const focusedTab = input.tabs.get(input.focusTabId)!;
      if (!focusWindowId || focusedTab.windowId !== focusWindowId) {
        throw ownershipError(
          "ELECTRON_CHROMIUM_FOCUS_INTENT_INVALID",
          "The Core focus tab does not belong to its sole native focus window."
        );
      }
    }
    const transitions = input.revealWindowIds.map((windowId) => {
      const window = input.windows.get(windowId);
      if (!window) {
        throw ownershipError(
          "ELECTRON_CHROMIUM_WINDOW_NOT_FOUND",
          "Core selected a runtime window that is not attached."
        );
      }
      return Object.freeze({
        host: window.host,
        mode: windowId === focusWindowId ? "focus" as const : "reveal" as const,
        topologyRevision: window.topologyRevision,
        windowGeneration: window.windowGeneration
      });
    });
    if (transitions.length === 0) {
      for (const window of input.windows.values()) {
        applyChromiumRuntimeWindowSurfaceVisibility(
          input,
          window,
          window.host.isVisible()
        );
      }
      return undefined;
    }
    if (input.signal?.aborted) {
      throw ownershipError(
        "ELECTRON_CHROMIUM_WINDOW_TRANSITION_CANCELLED",
        "Core cancelled the ownership projection before native submission."
      );
    }
    input.ownershipTransitions.synchronize(
      [...input.windows.values()].map((window) => window.host)
    );
    await input.beforeNativeSubmission();
    if (input.signal?.aborted) {
      throw ownershipError(
        "ELECTRON_CHROMIUM_WINDOW_TRANSITION_CANCELLED",
        "Core cancelled the ownership projection before native submission."
      );
    }
    continuation = input.ownershipTransitions.begin(
      input.effect,
      input.lifecycleEpoch,
      transitions
    );
  } catch (error) {
    if (provisioned) await compensateEmptySavedWindow(input, provisioned);
    throw error;
  }
  return coreEffectEventContinuation(
    continuation.completion.then((receipt) => {
      if (receipt.status === "applied") {
        const observedVisibility = new Map(
          receipt.windows.map((observation) => [
            observation.logicalWindowId,
            observation.visible
          ])
        );
        for (const window of input.windows.values()) {
          applyChromiumRuntimeWindowSurfaceVisibility(
            input,
            window,
            observedVisibility.get(window.host.logicalWindowId) ??
              window.host.isVisible()
          );
        }
      }
      return receipt;
    }),
    continuation.cancel
  );
}
