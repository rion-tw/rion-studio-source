import type { CoreEffectRequest } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeEffectExecutorInput } from "./chromiumRuntimeEffectPorts";
import type { ChromiumRuntimeRoleRecord, ChromiumRuntimeWindowRecord } from "./chromiumRuntimeAppKitProjection";
import { effectiveChromiumRuntimeZoomFactor } from "./chromiumRuntimeWindowZoomController";

/** Rust selects the factor; this adapter mutates and reads back only its exact Role. */
export function applyChromiumRuntimeRoleZoom(input: {
  effect: CoreEffectRequest;
  action: Extract<CoreEffectRequest["action"], { type: "embeddedSetRuntimeRoleZoom" }>;
  ports: ChromiumRuntimeEffectExecutorInput;
  roles: ReadonlyMap<string, ChromiumRuntimeRoleRecord>;
  windows: ReadonlyMap<string, ChromiumRuntimeWindowRecord>;
}) {
  const { request, zoomFactor, windowZoomFactor } = input.action;
  const window = input.windows.get(request.windowId);
  const role = input.roles.get(request.roleId);
  const fail = (code: string) => new RionBridgeError({ code, message: "The exact Role zoom projection could not be verified." });
  if (input.effect.completionPolicy !== "eventBound" || input.effect.deadlineMs !== undefined || input.effect.target.kind !== "app" ||
      input.effect.target.handleId !== request.windowId || !window || window.host.isDestroyed() ||
      window.windowGeneration !== request.windowGeneration || window.topologyRevision !== request.topologyRevision ||
      (window.windowZoomFactor ?? 1) !== windowZoomFactor || !role || role.tabId !== request.tabId ||
      role.windowId !== request.windowId || role.generation !== request.surfaceGeneration ||
      role.ownerGeneration !== request.ownerGeneration ||
      ![request.previousZoomFactor, zoomFactor].includes(role.zoomFactor)) {
    throw fail("ELECTRON_RUNTIME_ROLE_ZOOM_STALE");
  }
  const previous = effectiveChromiumRuntimeZoomFactor(request.previousZoomFactor, windowZoomFactor);
  const next = effectiveChromiumRuntimeZoomFactor(zoomFactor, windowZoomFactor);
  const read = () => input.ports.surfaces.readProjection(role.roleId, role.generation).zoomFactor;
  const write = (factor: number) => input.ports.surfaces.setZoomFactor(role.roleId, role.generation, factor);
  // An invalid receipt may require compensation after a successful native write.
  if (read() !== effectiveChromiumRuntimeZoomFactor(role.zoomFactor, windowZoomFactor)) {
    throw fail("ELECTRON_RUNTIME_ROLE_ZOOM_NATIVE_STALE");
  }
  try {
    write(next);
    if (read() !== next) throw fail("ELECTRON_RUNTIME_ROLE_ZOOM_READBACK_FAILED");
  } catch (error) {
    try { write(previous); if (read() !== previous) throw error; }
    catch { throw fail("ELECTRON_RUNTIME_ROLE_ZOOM_COMPENSATION_UNKNOWN"); }
    throw error;
  }
  role.zoomFactor = zoomFactor;
  return { request: { ...request }, zoomFactor };
}
