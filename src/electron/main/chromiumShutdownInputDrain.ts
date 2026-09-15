import type { CoreAddonClient } from "../core/coreAddonClient";
import type { MacroInputEpochRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";

/** EventBound: Core owns cancellation and release; the effect stream stays open. */
export async function drainChromiumShutdownInput(
  core: Pick<CoreAddonClient, "invoke">,
  roleIds: readonly string[]
): Promise<void> {
  const roles = [...new Set(roleIds)];
  const requireExact = (roleId: string, receipt: MacroInputEpochRecord, epoch?: number): MacroInputEpochRecord => {
    if (receipt.roleId !== roleId || receipt.current !== true ||
        !Number.isSafeInteger(receipt.inputEpoch) || receipt.inputEpoch < 1 ||
        (epoch !== undefined && receipt.inputEpoch !== epoch)) {
      throw new RionBridgeError({ code: "ELECTRON_CHROMIUM_SHUTDOWN_INPUT_UNVERIFIED",
        message: "Core did not confirm the exact shutdown input epoch." });
    }
    return receipt;
  };
  const fenced = await Promise.allSettled(roles.map(async roleId =>
    requireExact(roleId, await core.invoke({ type: "macroInputFence", roleId }))
  ));
  // Drain every successfully fenced owner even if a sibling fence failed.
  const drained = await Promise.allSettled(fenced.flatMap(result => result.status === "fulfilled"
    ? [(async () => {
      const { roleId, inputEpoch } = result.value;
      requireExact(roleId, await core.invoke({ type: "macroInputDrain", roleId, inputEpoch }), inputEpoch);
    })()] : []));
  const failure = [...fenced, ...drained].find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
