import type {
  CoreErrorPayload, EmbeddedKeyEffectRecord, TrustedInputSequenceFailureRecord
} from "../../shared/generated";
import { normalizeRionBridgeError } from "../ipc/errors";
import type { ChromiumNativeTrustedInputReceipt } from "./chromiumTrustedInputCoordinator";

export function receiptFailure(receipt: ChromiumNativeTrustedInputReceipt): CoreErrorPayload {
  return {
    code: receipt.errorCode ?? "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
    message: receipt.errorMessage ?? `Trusted input ended as ${receipt.status}.`
  };
}

/** Compensation and rollback each terminalize; neither failure erases the other. */
export async function recoverChromiumKeySequence(input: Readonly<{
  cause: CoreErrorPayload;
  transitionId: string | null;
  confirmedEffects: readonly EmbeddedKeyEffectRecord[];
  failedEffect: EmbeddedKeyEffectRecord | null;
  edges: readonly EmbeddedKeyEffectRecord[];
  compensate: (edges: readonly EmbeddedKeyEffectRecord[]) => Promise<CoreErrorPayload | null>;
  rollback: (transitionId: string) => Promise<void>;
}>): Promise<TrustedInputSequenceFailureRecord> {
  let compensationError: CoreErrorPayload | null;
  try { compensationError = await input.compensate(input.edges); }
  catch (cause) { compensationError = normalizeRionBridgeError(cause); }
  let rollbackError: CoreErrorPayload | null = null;
  if (input.transitionId) {
    try { await input.rollback(input.transitionId); }
    catch (cause) { rollbackError = normalizeRionBridgeError(cause); }
  }
  return {
    cause: input.cause,
    transitionId: input.transitionId,
    confirmedEffectCount: input.confirmedEffects.length,
    confirmedEffects: input.confirmedEffects.map(effect => structuredClone(effect)),
    failedEffect: input.failedEffect ? structuredClone(input.failedEffect) : null,
    compensationSucceeded: compensationError === null,
    rollbackSucceeded: rollbackError === null,
    compensationError,
    rollbackError
  };
}
