import type { CoreEffectRequest } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRuntimeRoleRecord,
  ChromiumRuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";
import type { ChromiumRuntimeShellEffectsPort } from
  "./chromiumRuntimeEffectPorts";

type OverlayShellAction = Extract<
  CoreEffectRequest["action"],
  { type: "overlayOpenMacroPage" | "overlayCopyCoordinate" }
>;

function shellError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value === value.trim() &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

export function executeChromiumRuntimeOverlayShellEffect(input: Readonly<{
  action: OverlayShellAction;
  effect: CoreEffectRequest;
  roles: Map<string, ChromiumRuntimeRoleRecord>;
  shellEffects: ChromiumRuntimeShellEffectsPort;
  windows: Map<string, ChromiumRuntimeWindowRecord>;
}>): unknown {
  const { action, effect, roles, shellEffects, windows } = input;
  const targetRoleId = effect.target.handleId;
  const requestedRoleId = action.type === "overlayOpenMacroPage"
    ? action.roleId
    : targetRoleId;
  if (
    !validIdentifier(targetRoleId) || !validIdentifier(requestedRoleId) ||
    requestedRoleId !== targetRoleId
  ) {
    throw shellError(
      "ELECTRON_ROLE_OVERLAY_EFFECT_TARGET_MISMATCH",
      "The Core overlay effect target does not match its role identity."
    );
  }
  const role = roles.get(targetRoleId);
  const window = role ? windows.get(role.windowId) : undefined;
  if (!role || !window || window.host.isDestroyed()) {
    throw shellError(
      "ELECTRON_ROLE_OVERLAY_EFFECT_OWNER_STALE",
      "The Core overlay effect no longer has an exact live Chromium role owner."
    );
  }
  return action.type === "overlayOpenMacroPage"
    ? shellEffects.openMacroPage(targetRoleId)
    : shellEffects.copyCoordinate(action.coordinate);
}
