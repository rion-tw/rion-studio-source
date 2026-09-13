import { ChromiumTrustedInputPendingLane, recordTrustedInputTrace,
  type PendingChromiumTrustedInput } from "./chromiumTrustedInputPendingLane";

/** The target observation is evidence of dispatch, never of game internal state. */
export function observeChromiumGameDelivery<P extends PendingChromiumTrustedInput>(
  lane: ChromiumTrustedInputPendingLane<P>,
  identity: { roleId: string; generation: number; documentInstanceId: string },
  payload: unknown
): boolean | null {
  if (!payload || typeof payload !== "object" || !("delivery" in payload)) return null;
  const value = payload as Record<string, unknown>;
  const pending = lane.forRole(identity.roleId);
  if (!pending || pending.terminal || !pending.cdpInvoked ||
    identity.generation !== pending.frame.generation ||
    identity.documentInstanceId !== pending.frame.documentInstanceId ||
    value.dispatchId !== pending.inputSequence) return false;
  const effect = pending.request.keyEffect;
  const owner = value.deliveryOwner as Record<string, unknown> | null;
  const delivery = value.delivery as Record<string, unknown> | null;
  const expectedOwner = pending.request.action.type === "key"
    ? pending.request.action.ownerId : "core-held-key-projection";
  if (!effect || value.code !== effect.code ||
    value.phase !== (effect.phase === "keyUp" ? "keyup" : "keydown") ||
    !owner || owner.ownerId !== expectedOwner || owner.requestId !== pending.request.requestId ||
    owner.inputEpoch !== pending.request.inputEpoch ||
    owner.surfaceGeneration !== pending.request.surfaceGeneration || !delivery ||
    !["direct", "compatibility", "modifier-overlap", "target-retired", "delivery-failed"].includes(String(delivery.kind)) ||
    !["canvas", "document"].includes(String(delivery.target)) || typeof delivery.isTrusted !== "boolean" ||
    (delivery.kind === "direct" && delivery.isTrusted !== true) ||
    (delivery.kind === "compatibility" && delivery.isTrusted !== false)) {
    lane.mismatch(pending);
    return false;
  }
  const failed = delivery.kind === "target-retired" || delivery.kind === "delivery-failed";
  recordTrustedInputTrace(pending, "preload", `game-target-${delivery.kind}`,
    failed ? "GAME_DELIVERY_UNCONFIRMED" : delivery.kind === "modifier-overlap"
      ? "PHYSICAL_MODIFIER_OWNER_PRESERVED" : delivery.isTrusted
        ? "TRUSTED_TARGET_OBSERVED" : "SYNTHETIC_COMPATIBILITY_DELIVERED");
  if (failed) {
    pending.failureStage = "game-target-delivery";
    lane.finish(pending, "indeterminate", delivery.kind === "target-retired"
      ? "SYSTEM_TRUSTED_INPUT_GAME_TARGET_RETIRED" : "SYSTEM_TRUSTED_INPUT_GAME_DELIVERY_FAILED",
      "The original game input target did not confirm paired delivery.", false);
    return false;
  }
  pending.gameDeliveryConfirmed = true;
  lane.maybeApply(pending);
  return true;
}
