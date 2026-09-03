import type { CoreEffectRequest } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRuntimeEffectExecutorInput,
  ChromiumRuntimeHostPort
} from "./chromiumRuntimeEffectExecutor";
import type {
  ChromiumRuntimeTabRecord,
  ChromiumRuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";

type ProvisionAction = Extract<
  CoreEffectRequest["action"],
  { type: "embeddedProvisionWindowForTabMove" }
>;
type RetireAction = Extract<
  CoreEffectRequest["action"],
  { type: "embeddedRetireProvisionedWindow" }
>;

interface RuntimeWindowProvisionState {
  readonly ports: ChromiumRuntimeEffectExecutorInput;
  readonly windows: Map<string, ChromiumRuntimeWindowRecord>;
  readonly tabs: Map<string, ChromiumRuntimeTabRecord>;
}

function provisionError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value === value.trim() && !value.includes("/") && !value.includes("\\") &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function exactTargetProjection(
  action: ProvisionAction,
  host: ChromiumRuntimeHostPort
): boolean {
  const projection = host.readProjection();
  return host.logicalWindowId === action.target.windowId &&
    projection.displayId === action.target.displayId &&
    projection.presentation === action.target.presentation &&
    projection.bounds.x === action.target.bounds.x &&
    projection.bounds.y === action.target.bounds.y &&
    projection.bounds.width === action.target.bounds.width &&
    projection.bounds.height === action.target.bounds.height &&
    !projection.visible && !projection.focused;
}

function requireEventBoundEffect(effect: CoreEffectRequest, handleId: string): void {
  if (
    effect.target.kind !== "app" || effect.target.handleId !== handleId ||
    effect.completionPolicy !== "eventBound" || effect.deadlineMs !== undefined
  ) {
    throw provisionError(
      "ELECTRON_CHROMIUM_WINDOW_PROVISION_EFFECT_INVALID",
      "Core supplied a mismatched or deadline-bound runtime-window provision effect."
    );
  }
}

function exactExistingProvision(
  action: ProvisionAction,
  record: ChromiumRuntimeWindowRecord
): boolean {
  if (
    record.windowGeneration !== action.targetWindowGeneration ||
    record.topologyRevision !== action.targetTopologyRevision ||
    record.tabIds.length !== 0 || record.activeTabId !== "" ||
    record.host.isDestroyed()
  ) {
    return false;
  }
  try {
    return exactTargetProjection(action, record.host);
  } catch {
    return false;
  }
}

/**
 * Creates a hidden, zero-tab native host for a Core-issued tab-move target.
 * The source remains the sole tab owner until a later exact Core/AppKit move
 * transaction commits. No tab is cloned or temporarily projected twice.
 */
export async function provisionChromiumRuntimeWindowForTabMove(
  state: RuntimeWindowProvisionState,
  effect: CoreEffectRequest,
  action: ProvisionAction
): Promise<Readonly<{
  windowId: string;
  windowGeneration: number;
  topologyRevision: number;
}>> {
  requireEventBoundEffect(effect, action.tabId);
  if (
    !validIdentifier(action.tabId) ||
    !validIdentifier(action.sourceWindowId) ||
    !validIdentifier(action.target.windowId) ||
    action.sourceWindowId === action.target.windowId ||
    !Number.isSafeInteger(action.sourceWindowGeneration) ||
    action.sourceWindowGeneration < 1 ||
    !Number.isSafeInteger(action.sourceTopologyRevision) ||
    action.sourceTopologyRevision < 1 ||
    !Number.isSafeInteger(action.targetWindowGeneration) ||
    action.targetWindowGeneration < 1 ||
    !Number.isSafeInteger(action.targetTopologyRevision) ||
    action.targetTopologyRevision < 1
  ) {
    throw provisionError(
      "ELECTRON_CHROMIUM_WINDOW_PROVISION_FENCE_INVALID",
      "Core supplied malformed runtime-window provision identities or fences."
    );
  }
  const source = state.windows.get(action.sourceWindowId);
  const tab = state.tabs.get(action.tabId);
  if (
    !source || source.host.isDestroyed() ||
    source.windowGeneration !== action.sourceWindowGeneration ||
    source.topologyRevision !== action.sourceTopologyRevision ||
    !source.tabIds.includes(action.tabId) || tab?.windowId !== action.sourceWindowId
  ) {
    throw provisionError(
      "ELECTRON_CHROMIUM_WINDOW_PROVISION_SOURCE_STALE",
      "The provisional target lost its exact Core/native source tab fence."
    );
  }
  const existing = state.windows.get(action.target.windowId);
  if (existing) {
    if (!exactExistingProvision(action, existing)) {
      throw provisionError(
        "ELECTRON_CHROMIUM_WINDOW_PROVISION_TARGET_CONFLICT",
        "The Core-generated target identity already owns another native topology."
      );
    }
    return Object.freeze({
      windowId: action.target.windowId,
      windowGeneration: action.targetWindowGeneration,
      topologyRevision: action.targetTopologyRevision
    });
  }
  const attemptGeneration = tab.specification.attemptGeneration;
  if (!validIdentifier(attemptGeneration)) {
    throw provisionError(
      "ELECTRON_CHROMIUM_WINDOW_PROVISION_ATTEMPT_STALE",
      "The source tab lost its canonical launch-attempt generation."
    );
  }

  let host: ChromiumRuntimeHostPort | undefined;
  try {
    host = await state.ports.hosts.createEmpty(action.target, {
      attemptGeneration,
      windowGeneration: action.targetWindowGeneration,
      topologyRevision: action.targetTopologyRevision
    });
    const sourceIsAppKit = source.host.appKitIdentity !== undefined;
    const targetIsAppKit = host.appKitIdentity !== undefined;
    if (
      host.isDestroyed() || sourceIsAppKit !== targetIsAppKit ||
      !exactTargetProjection(action, host) ||
      (targetIsAppKit && (
        host.appKitIdentity!.logicalWindowId !== action.target.windowId ||
        host.appKitIdentity!.launchGeneration !== attemptGeneration ||
        !Number.isSafeInteger(host.appKitIdentity!.nativeGeneration) ||
        host.appKitIdentity!.nativeGeneration < 1
      ))
    ) {
      throw provisionError(
        "ELECTRON_CHROMIUM_WINDOW_PROVISION_NATIVE_RECEIPT_INVALID",
        "The native host did not return the exact hidden zero-tab provision receipt."
      );
    }
  } catch (error) {
    if (host && !host.isDestroyed()) {
      try {
        await host.close();
      } catch {
        throw provisionError(
          "ELECTRON_CHROMIUM_WINDOW_PROVISION_COMPENSATION_FAILED",
          "The invalid empty native host could not be retired and remains quarantined."
        );
      }
    }
    throw error;
  }

  state.windows.set(action.target.windowId, {
    host,
    hostTarget: action.target,
    tabIds: [],
    hiddenTabIds: new Set(),
    activeTabId: "",
    windowGeneration: action.targetWindowGeneration,
    topologyRevision: action.targetTopologyRevision,
    lastAdapterSequence: 0,
    windowZoomFactor: 1
  });
  return Object.freeze({
    windowId: action.target.windowId,
    windowGeneration: action.targetWindowGeneration,
    topologyRevision: action.targetTopologyRevision
  });
}

/** Retires only an exact empty host; close completion is the terminal event. */
export async function retireChromiumRuntimeProvisionedWindow(
  state: RuntimeWindowProvisionState,
  effect: CoreEffectRequest,
  action: RetireAction
): Promise<Readonly<{ windowId: string; retired: boolean }>> {
  requireEventBoundEffect(effect, action.windowId);
  if (
    !validIdentifier(action.windowId) ||
    !Number.isSafeInteger(action.windowGeneration) ||
    action.windowGeneration < 1 ||
    !Number.isSafeInteger(action.topologyRevision) ||
    action.topologyRevision < 1
  ) {
    throw provisionError(
      "ELECTRON_CHROMIUM_WINDOW_RETIRE_FENCE_INVALID",
      "Core supplied malformed runtime-window retirement fences."
    );
  }
  const record = state.windows.get(action.windowId);
  if (!record) {
    return Object.freeze({ windowId: action.windowId, retired: false });
  }
  if (
    record.windowGeneration !== action.windowGeneration ||
    record.topologyRevision !== action.topologyRevision ||
    record.tabIds.length !== 0 || record.activeTabId !== ""
  ) {
    throw provisionError(
      "ELECTRON_CHROMIUM_WINDOW_RETIRE_STALE",
      "The runtime window is no longer an exact empty retirement target."
    );
  }
  try {
    await record.host.close();
  } catch {
    throw provisionError(
      "ELECTRON_CHROMIUM_WINDOW_RETIRE_INDETERMINATE",
      "The exact native close result is unknown; the host remains quarantined."
    );
  }
  if (!record.host.isDestroyed()) {
    throw provisionError(
      "ELECTRON_CHROMIUM_WINDOW_RETIRE_INDETERMINATE",
      "The native host acknowledged close without exact destruction evidence."
    );
  }
  if (state.windows.get(action.windowId) === record) {
    state.windows.delete(action.windowId);
  }
  return Object.freeze({ windowId: action.windowId, retired: true });
}
