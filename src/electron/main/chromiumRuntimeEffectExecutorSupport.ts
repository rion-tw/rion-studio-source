import type {
  CoreEffectRequest,
  EmbeddedLaunchTargetRecord,
  EmbeddedRoleViewEffectRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeHostPort } from "./chromiumRuntimeHostPorts";

export function runtimeError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

export function requireIdentifier(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    [...value].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    throw runtimeError(
      "ELECTRON_CHROMIUM_RUNTIME_ID_INVALID",
      `Core supplied an invalid ${field} identity.`
    );
  }
  return value;
}

export function requireAppTarget(effect: CoreEffectRequest): void {
  if (effect.target.kind !== "app") {
    throw runtimeError(
      "ELECTRON_CHROMIUM_RUNTIME_TARGET_INVALID",
      "A runtime topology effect must target the Electron application actor."
    );
  }
}

export function targetMatchesCurrentHost(
  target: EmbeddedLaunchTargetRecord,
  host: ChromiumRuntimeHostPort
): boolean {
  const projection = host.readProjection();
  return target.windowId === host.logicalWindowId &&
    target.displayId === projection.displayId &&
    target.presentation === projection.presentation &&
    target.bounds.x === projection.bounds.x &&
    target.bounds.y === projection.bounds.y &&
    target.bounds.width === projection.bounds.width &&
    target.bounds.height === projection.bounds.height;
}

export function expectedEngineIsChromium(engine: string): boolean {
  return engine === "chromium";
}

export function sameNormalizedRect(
  left: EmbeddedRoleViewEffectRecord["rect"],
  right: EmbeddedRoleViewEffectRecord["rect"]
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

export function sortedSnapshot<Value extends {
  roleId?: string;
  surfaceId?: string;
  windowId?: string;
}>(
  values: Value[]
): Value[] {
  return values.sort((left, right) =>
    (left.roleId ?? left.surfaceId ?? left.windowId ?? "").localeCompare(
      right.roleId ?? right.surfaceId ?? right.windowId ?? ""
    )
  );
}
