import { describe, expect, it, vi } from "vitest";

import { RustMacroTimingScheduler } from "../src/main/macros/RustMacroTimingScheduler";

describe("RustMacroTimingScheduler", () => {
  it("forwards waits and cancellation to the monotonic native scheduler", async () => {
    const core = {
      cancelWait: vi.fn(),
      scheduleWait: vi.fn(async () => undefined)
    };
    const scheduler = new RustMacroTimingScheduler(core as never);

    await scheduler.wait("invocation:role:delay:1", 250);
    scheduler.cancel("invocation:role:delay:1");

    expect(core.scheduleWait).toHaveBeenCalledWith("invocation:role:delay:1", 250);
    expect(core.cancelWait).toHaveBeenCalledWith("invocation:role:delay:1");
  });
});
