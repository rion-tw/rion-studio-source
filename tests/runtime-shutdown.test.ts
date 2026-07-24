import { describe, expect, it, vi } from "vitest";

import { saveRuntimeSessionThenStopAll } from "../src/main/browser/runtimeShutdown";

describe("Game Window shutdown ordering", () => {
  it("freezes and saves the clean session before stopping browser tabs", async () => {
    const calls: string[] = [];

    await saveRuntimeSessionThenStopAll({
      browserManager: {
        stopAll: vi.fn(async () => {
          calls.push("stop");
        })
      },
      sessionManager: {
        flushForQuit: vi.fn(async () => {
          calls.push("save");
        })
      },
      onSaveError: vi.fn(),
      onStopError: vi.fn()
    });

    expect(calls).toEqual(["save", "stop"]);
  });

  it("still stops browser tabs when saving the session fails", async () => {
    const saveError = new Error("disk unavailable");
    const onSaveError = vi.fn();
    const stopAll = vi.fn().mockResolvedValue(undefined);

    await saveRuntimeSessionThenStopAll({
      browserManager: { stopAll },
      sessionManager: {
        flushForQuit: vi.fn().mockRejectedValue(saveError)
      },
      onSaveError,
      onStopError: vi.fn()
    });

    expect(onSaveError).toHaveBeenCalledWith(saveError);
    expect(stopAll).toHaveBeenCalledOnce();
  });
});
