import { MacosAppKitRuntimeEventBridge } from "../main/macosAppKitRuntimeEventBridge";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChromiumRuntimeEffectExecutor } from "../main/chromiumRuntimeEffectExecutor";
import { CoreEffectCoordinator } from "../main/coreEffectCoordinator";

/** E2E-only accepted projection barrier; no production timer or renderer API. */
export function installRuntimeTargetProjectionBarrier(): void {
  if (process.env.RION_STUDIO_E2E_PHASE !== "chromium-tabs-visible-seed") return;
  const origin = process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN!;
  const control = join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "target-projection-gate.json");
  const held = new Set<string>();
  const consumed = new Set<string>();
  const executor = ChromiumRuntimeEffectExecutor.prototype;
  const execute = executor.execute;
  executor.execute = async function (effect, context) {
    const action = effect.action;
    const windows = action.type === "embeddedApplyAppKitProjection"
      ? action.projection.windows.map(window => window.identity.logicalWindowId)
      : action.type === "embeddedFollowRoleOwnership" ? action.windows?.map(window => window.windowId) ?? [] : [];
    if (windows.length && existsSync(control)) {
      const target = JSON.parse(readFileSync(control, "utf8")) as { windowId: string };
      for (const windowId of windows) {
        const id = `target-projection-${windowId}`;
        if (windowId !== target.windowId || consumed.has(id)) continue;
        consumed.add(id); held.add(windowId);
        try {
          const response = await fetch(`${origin}/role/${id}`, { signal: context?.signal });
          if (!response.ok) throw new Error(`Projection barrier ${id} failed`);
          await response.text();
        } finally { held.delete(windowId); }
      }
    }
    return execute.call(this, effect, context);
  };
  const reported = new Set<string>();
  const observeWait = async (windowId: string) => {
    if (held.has(windowId) && !reported.has(windowId)) {
      reported.add(windowId);
      const response = await fetch(`${origin}/api/event`, { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId: `target-projection-${windowId}`, kind: "launch-waiting-for-target-projection" }) });
      if (!response.ok) throw new Error("Projection fence observation failed");
    }
  };
  const coordinator = CoreEffectCoordinator.prototype;
  const settle = coordinator.settleWindowProjection;
  coordinator.settleWindowProjection = async function (windowId) {
    await observeWait(windowId);
    return settle.call(this, windowId);
  };
  // Launch now fences received native events before their emitted projection.
  const events = MacosAppKitRuntimeEventBridge.prototype;
  const settleEvents = events.settleWindowEvents;
  events.settleWindowEvents = async function (windowId) {
    await observeWait(windowId);
    return settleEvents.call(this, windowId);
  };
}
