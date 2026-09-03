import type {
  CoreEffectRequest,
  RuntimeWindowZoomNativeReceiptRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRuntimeRoleRecord,
  ChromiumRuntimeWebSurfaceRecord,
  ChromiumRuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";
import type { ChromiumRuntimeEffectExecutorInput } from
  "./chromiumRuntimeEffectPorts";

const MIN_ZOOM_FACTOR = 0.25;
const MAX_ZOOM_FACTOR = 5;

type ZoomAction = Extract<
  CoreEffectRequest["action"],
  { type: "embeddedSetRuntimeWindowZoom" }
>;

interface RuntimeWindowZoomControllerInput {
  readonly action: ZoomAction;
  readonly effect: CoreEffectRequest;
  readonly ports: ChromiumRuntimeEffectExecutorInput;
  readonly roles: Map<string, ChromiumRuntimeRoleRecord>;
  readonly webSurfaces: Map<string, ChromiumRuntimeWebSurfaceRecord>;
  readonly windows: Map<string, ChromiumRuntimeWindowRecord>;
}

interface ZoomMutation {
  readonly apply: () => void;
  readonly rollback: () => void;
}

function zoomError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function requireZoom(value: number, field: string): number {
  if (!Number.isFinite(value) || value < MIN_ZOOM_FACTOR || value > MAX_ZOOM_FACTOR) {
    throw zoomError(
      "ELECTRON_RUNTIME_WINDOW_ZOOM_FACTOR_INVALID",
      `Core supplied an invalid ${field} zoom factor.`
    );
  }
  return value;
}

function currentWindowZoom(record: ChromiumRuntimeWindowRecord): number {
  return requireZoom(record.windowZoomFactor ?? 1, "mirrored window");
}

export function effectiveChromiumRuntimeZoomFactor(
  baseZoomFactor: number,
  windowZoomFactor: number
): number {
  return Math.min(
    MAX_ZOOM_FACTOR,
    Math.max(
      MIN_ZOOM_FACTOR,
      requireZoom(baseZoomFactor, "base") * requireZoom(windowZoomFactor, "window")
    )
  );
}

function exactAppKitIdentity(
  left: ChromiumRuntimeWindowRecord["host"]["appKitIdentity"],
  right: ChromiumRuntimeWindowRecord["host"]["appKitIdentity"]
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined &&
      left.logicalWindowId === right.logicalWindowId &&
      left.launchGeneration === right.launchGeneration &&
      left.nativeGeneration === right.nativeGeneration;
}

function nativeSurfaceMutation(input: Readonly<{
  baseZoomFactor: number;
  currentWindowZoomFactor: number;
  nextWindowZoomFactor: number;
  read: () => number | undefined;
  write: (zoomFactor: number) => void;
}>): ZoomMutation {
  const previousNativeZoom = effectiveChromiumRuntimeZoomFactor(
    input.baseZoomFactor,
    input.currentWindowZoomFactor
  );
  const nextNativeZoom = effectiveChromiumRuntimeZoomFactor(
    input.baseZoomFactor,
    input.nextWindowZoomFactor
  );
  if (input.read() !== previousNativeZoom) {
    throw zoomError(
      "ELECTRON_RUNTIME_WINDOW_ZOOM_NATIVE_STALE",
      "A live Chromium surface does not match its current Core-owned zoom projection."
    );
  }
  return Object.freeze({
    apply: () => {
      if (previousNativeZoom === nextNativeZoom) return;
      input.write(nextNativeZoom);
      if (input.read() !== nextNativeZoom) {
        throw zoomError(
          "ELECTRON_RUNTIME_WINDOW_ZOOM_READBACK_FAILED",
          "A live Chromium surface did not acknowledge its requested zoom factor."
        );
      }
    },
    rollback: () => {
      if (input.read() === previousNativeZoom) return;
      input.write(previousNativeZoom);
      if (input.read() !== previousNativeZoom) {
        throw zoomError(
          "ELECTRON_RUNTIME_WINDOW_ZOOM_COMPENSATION_UNKNOWN",
          "A live Chromium surface did not acknowledge zoom compensation."
        );
      }
    }
  });
}

/**
 * Event-bound reversible native fanout. Rust computes and commits the window
 * multiplier; Electron owns only exact WebContents handles and readback.
 */
export async function applyChromiumRuntimeWindowZoomEffect(
  input: RuntimeWindowZoomControllerInput
): Promise<RuntimeWindowZoomNativeReceiptRecord> {
  const { action, effect, ports, roles, webSurfaces, windows } = input;
  if (
    effect.target.kind !== "app" || effect.target.handleId !== action.windowId ||
    effect.completionPolicy !== "eventBound" || effect.deadlineMs !== undefined
  ) {
    throw zoomError(
      "ELECTRON_RUNTIME_WINDOW_ZOOM_EFFECT_INVALID",
      "Runtime-window zoom requires the exact EventBound application target."
    );
  }
  const previousZoomFactor = requireZoom(
    action.previousZoomFactor,
    "previous window"
  );
  const nextZoomFactor = requireZoom(action.zoomFactor, "next window");
  const window = windows.get(action.windowId);
  if (
    !window || window.host.isDestroyed() ||
    window.windowGeneration !== action.windowGeneration ||
    window.topologyRevision !== action.topologyRevision
  ) {
    throw zoomError(
      "ELECTRON_RUNTIME_WINDOW_ZOOM_FENCE_STALE",
      "Runtime-window zoom lost its exact Core/native window fence."
    );
  }
  const nativeHost = window.host;
  const nativeHostId = nativeHost.id;
  const appKitIdentity = nativeHost.appKitIdentity
    ? Object.freeze({ ...nativeHost.appKitIdentity })
    : undefined;
  const mirroredZoomFactor = currentWindowZoom(window);
  if (
    mirroredZoomFactor !== previousZoomFactor &&
    mirroredZoomFactor !== nextZoomFactor
  ) {
    throw zoomError(
      "ELECTRON_RUNTIME_WINDOW_ZOOM_MIRROR_STALE",
      "Electron's window multiplier no longer matches either transaction fence."
    );
  }
  if (!ports.popupZoom) {
    throw zoomError(
      "ELECTRON_RUNTIME_WINDOW_ZOOM_POPUP_PORT_MISSING",
      "Runtime-window zoom requires the controlled popup transaction port."
    );
  }
  const popup = await ports.popupZoom.prepareWindowZoomTransaction({
    windowId: action.windowId,
    windowGeneration: action.windowGeneration,
    topologyRevision: action.topologyRevision,
    previousZoomFactor,
    nextZoomFactor
  });
  const applied: ZoomMutation[] = [];
  try {
    if (
      windows.get(action.windowId) !== window || window.host !== nativeHost ||
      nativeHost.isDestroyed() || nativeHost.id !== nativeHostId ||
      !exactAppKitIdentity(appKitIdentity, nativeHost.appKitIdentity) ||
      window.windowGeneration !== action.windowGeneration ||
      window.topologyRevision !== action.topologyRevision ||
      currentWindowZoom(window) !== mirroredZoomFactor
    ) {
      throw zoomError(
        "ELECTRON_RUNTIME_WINDOW_ZOOM_FENCE_STALE",
        "Runtime-window zoom lost its exact native host while preparing popup fanout."
      );
    }
    const roleRecords = [...roles.values()].filter((role) =>
      role.windowId === action.windowId);
    const webRecords = [...webSurfaces.values()].filter((surface) =>
      surface.windowId === action.windowId);
    const mutations: ZoomMutation[] = [
      ...roleRecords.map((role) => nativeSurfaceMutation({
        baseZoomFactor: role.zoomFactor,
        currentWindowZoomFactor: mirroredZoomFactor,
        nextWindowZoomFactor: nextZoomFactor,
        read: () => ports.surfaces.readProjection(
          role.roleId,
          role.generation
        ).zoomFactor,
        write: (zoomFactor) => ports.surfaces.setZoomFactor(
          role.roleId,
          role.generation,
          zoomFactor
        )
      })),
      ...webRecords.map((surface) => nativeSurfaceMutation({
        baseZoomFactor: surface.zoomFactor,
        currentWindowZoomFactor: mirroredZoomFactor,
        nextWindowZoomFactor: nextZoomFactor,
        read: () => ports.webSurfaces.readProjection(
          surface.surfaceId,
          surface.generation
        ).zoomFactor,
        write: (zoomFactor) => ports.webSurfaces.setZoomFactor(
          surface.surfaceId,
          surface.generation,
          zoomFactor
        )
      }))
    ];
    for (const mutation of mutations) {
      applied.push(mutation);
      mutation.apply();
    }
    popup.apply();
    if (
      windows.get(action.windowId) !== window || window.host !== nativeHost ||
      nativeHost.isDestroyed() || nativeHost.id !== nativeHostId ||
      !exactAppKitIdentity(appKitIdentity, nativeHost.appKitIdentity) ||
      window.windowGeneration !== action.windowGeneration ||
      window.topologyRevision !== action.topologyRevision
    ) {
      throw zoomError(
        "ELECTRON_RUNTIME_WINDOW_ZOOM_FENCE_STALE",
        "Runtime-window zoom lost its exact native host before terminal readback."
      );
    }
    const receipt = Object.freeze({
      windowId: action.windowId,
      windowGeneration: action.windowGeneration,
      topologyRevision: action.topologyRevision,
      previousZoomFactor,
      nextZoomFactor,
      roleSurfaceCount: roleRecords.length,
      globalWebSurfaceCount: webRecords.length,
      popupSurfaceCount: popup.popupSurfaceCount,
      status: "applied" as const
    });
    popup.commit();
    window.windowZoomFactor = nextZoomFactor;
    return receipt;
  } catch (error) {
    const compensationFailures: unknown[] = [];
    try {
      popup.rollback();
    } catch (rollbackError) {
      compensationFailures.push(rollbackError);
    }
    for (const mutation of [...applied].reverse()) {
      try {
        mutation.rollback();
      } catch (rollbackError) {
        compensationFailures.push(rollbackError);
      }
    }
    if (compensationFailures.length > 0) {
      throw zoomError(
        "ELECTRON_RUNTIME_WINDOW_ZOOM_COMPENSATION_UNKNOWN",
        "Runtime-window zoom failed and native compensation could not be verified."
      );
    }
    throw error;
  }
}
