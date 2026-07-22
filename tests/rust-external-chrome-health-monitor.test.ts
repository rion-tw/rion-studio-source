import { describe, expect, it, vi } from "vitest";

import { RustExternalChromeHealthMonitor } from "../src/main/browser/RustExternalChromeHealthMonitor";
import type { CoreEvent } from "../src/shared/generated";

describe("RustExternalChromeHealthMonitor", () => {
  it("uses typed commands and forwards health and probe events", async () => {
    let listener: ((events: CoreEvent[]) => void) | undefined;
    const invoke = vi.fn(async () => ({}));
    const monitor = new RustExternalChromeHealthMonitor({
      invoke,
      subscribe: vi.fn((next) => {
        listener = next;
        return () => undefined;
      })
    } as never);
    const health = vi.fn();
    const probe = vi.fn();
    monitor.onHealth(health);
    monitor.onProbeFailure(probe);

    await monitor.register("role-1");
    monitor.heartbeat("role-1", false);
    monitor.setSuspended(true);
    await monitor.remove("role-1");
    listener?.([
      { type: "externalHealthChanged", roleId: "role-1", health: "unresponsive" },
      {
        type: "externalHealthProbeFailed",
        roleId: "role-1",
        errorCode: "CDP_DISCONNECTED",
        errorMessage: "disconnected"
      }
    ]);

    expect(invoke).toHaveBeenCalledWith({ type: "externalHealthRegister", roleId: "role-1" });
    expect(invoke).toHaveBeenCalledWith({
      type: "externalHealthHeartbeat",
      roleId: "role-1",
      pageHidden: false
    });
    expect(invoke).toHaveBeenCalledWith({ type: "externalHealthSuspend", suspended: true });
    expect(invoke).toHaveBeenCalledWith({ type: "externalHealthRemove", roleId: "role-1" });
    expect(health).toHaveBeenCalledWith("role-1", "unresponsive");
    expect(probe).toHaveBeenCalledWith({
      errorCode: "CDP_DISCONNECTED",
      errorMessage: "disconnected",
      roleId: "role-1"
    });
  });
});
