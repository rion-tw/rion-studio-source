import type { BrowserActionRequest, CoreEffectRequest } from
  "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumNativeTrustedInputReceipt } from
  "./chromiumTrustedInputCoordinator";
import type { ChromiumRuntimeRoleRecord } from
  "./chromiumRuntimeAppKitProjection";
import type { ChromiumRuntimeTrustedInputPort } from
  "./chromiumRuntimeEffectPorts";

function inputError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

export async function executeChromiumRuntimeBrowserAction(input: Readonly<{
  effect: CoreEffectRequest;
  request: BrowserActionRequest;
  roles: Map<string, ChromiumRuntimeRoleRecord>;
  trustedInput?: ChromiumRuntimeTrustedInputPort;
}>): Promise<ChromiumNativeTrustedInputReceipt> {
  const { effect, request, roles, trustedInput } = input;
  const roleId = request.roleId;
  if (
    typeof roleId !== "string" || roleId.length === 0 || roleId !== roleId.trim() ||
    effect.target.kind !== "webContents" || effect.target.handleId !== roleId ||
    effect.completionPolicy !== "deadlineBound" ||
    effect.deadlineMs !== request.deadlineMs
  ) {
    throw inputError(
      "ELECTRON_CHROMIUM_INPUT_EFFECT_IDENTITY_MISMATCH",
      "The Core browser-action target or deadline fence is inconsistent."
    );
  }
  const role = roles.get(roleId);
  if (!role) {
    throw inputError(
      "ELECTRON_CHROMIUM_INPUT_ROLE_NOT_FOUND",
      "The browser action has no exact live Chromium role owner."
    );
  }
  if (!trustedInput) {
    throw inputError(
      "ELECTRON_CHROMIUM_TRUSTED_INPUT_UNAVAILABLE",
      "This Chromium runtime has no native trusted-input adapter."
    );
  }
  const receipt = await trustedInput.execute(request);
  if (
    receipt.requestId !== request.requestId || receipt.roleId !== roleId ||
    receipt.inputEpoch !== request.inputEpoch ||
    receipt.surfaceGeneration !== role.generation ||
    receipt.status !== "applied" || receipt.errorCode !== null ||
    receipt.errorMessage !== null || !Number.isSafeInteger(receipt.completedAtMs) ||
    receipt.completedAtMs < request.scheduledAtMs ||
    receipt.completedAtMs >= request.deadlineMs
  ) {
    throw inputError(
      "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
      "The native trusted-input adapter did not return the exact applied receipt."
    );
  }
  return Object.freeze({ ...receipt });
}
