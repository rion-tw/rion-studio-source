import type { ChromiumRoleTrustedInputArmEnvelope,
  ChromiumRoleTrustedInputExpectedEvent } from "../ipc/chromiumRoleTrustedInputProtocol";
import type { ChromiumNativeTrustedInputRequest } from "./chromiumTrustedInputCoordinator";

/** Both native adapters validate the action before creating this exact frame arm. */
export function createTrustedInputArmEnvelope(
  request: ChromiumNativeTrustedInputRequest,
  frameToken: string,
  inputSequence: string,
  expectedEvents: readonly ChromiumRoleTrustedInputExpectedEvent[]
): ChromiumRoleTrustedInputArmEnvelope {
  const legacyKey = request.action.type === "key" ? request.action : null;
  const suppressionCode = request.keyEffect?.code ?? legacyKey?.code ?? null;
  return Object.freeze({
    kind: "arm",
    roleId: request.roleId,
    generation: request.surfaceGeneration,
    frameToken,
    inputSequence,
    expectedEvents,
    // All keys in this lane are Macro-owned, even without a shortcut collision.
    // The page guard also excludes them from physical-key focus-loss cleanup.
    shortcutSuppression: suppressionCode
      ? Object.freeze({
          code: suppressionCode,
          phases: Object.freeze(expectedEvents.map(event => event.type as "keydown" | "keyup")),
          repeat: request.keyEffect?.autoRepeat ?? false
        })
      : null
  });
}
