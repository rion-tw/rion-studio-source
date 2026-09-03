import type { ChromiumRuntimeWindowRecord } from
  "./chromiumRuntimeAppKitProjection";
import { runtimeError } from "./chromiumRuntimeEffectExecutorSupport";

/**
 * Retires native hosts that legitimately own no tab. Tab-backed hosts are
 * closed by the tab teardown lane so their surfaces always terminalize first.
 */
export async function drainEmptyChromiumRuntimeHosts(
  windows: Map<string, ChromiumRuntimeWindowRecord>
): Promise<void> {
  const entries = [...windows.entries()];
  const results = await Promise.allSettled(entries.map(
    async ([windowId, record]) => {
      if (record.tabIds.length !== 0) {
        throw runtimeError(
          "ELECTRON_CHROMIUM_RUNTIME_HOST_TOPOLOGY_UNVERIFIED",
          "A native runtime host retained tabs after the tab teardown lane."
        );
      }
      if (!record.host.isDestroyed()) await record.host.close();
      if (!record.host.isDestroyed()) {
        throw runtimeError(
          "ELECTRON_CHROMIUM_RUNTIME_HOST_CLOSE_NOT_OBSERVED",
          "A zero-tab native runtime host did not acknowledge exact destruction."
        );
      }
      if (windows.get(windowId) === record) windows.delete(windowId);
    }
  ));
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure) throw failure.reason;
}
