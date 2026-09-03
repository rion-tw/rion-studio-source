import type { CoreEvent } from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import { ChromiumRuntimeLaunchCompletionCoordinator } from
  "../src/electron/main/chromiumRuntimeLaunchCompletionCoordinator";

const EXPECTED = {
  operationId: "operation-1",
  tabId: "tab-1",
  sourceId: "role-1",
  sourceType: "role" as const
};

function harness() {
  let listener: ((event: CoreEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const onError = vi.fn();
  const coordinator = new ChromiumRuntimeLaunchCompletionCoordinator({
    core: {
      subscribeCoreEvents: (next) => {
        listener = next;
        return unsubscribe;
      }
    },
    onError
  });
  coordinator.start();
  return {
    coordinator,
    emit: (event: CoreEvent) => listener?.(event),
    onError,
    unsubscribe
  };
}

function completion(
  overrides: Partial<Extract<CoreEvent, { type: "browserLaunchCompleted" }>> = {}
): Extract<CoreEvent, { type: "browserLaunchCompleted" }> {
  return {
    type: "browserLaunchCompleted",
    ...EXPECTED,
    ok: true,
    ...overrides
  };
}

describe("Chromium runtime launch completion coordinator", () => {
  it("resolves an exact event-bound waiter from the Core terminal event", async () => {
    const test = harness();
    const pending = test.coordinator.awaitExact(EXPECTED);

    test.emit(completion());

    await expect(pending).resolves.toEqual({ ...EXPECTED, ok: true });
    expect(test.onError).not.toHaveBeenCalled();
  });

  it("retains a completion that arrives before restore installs its waiter", async () => {
    const test = harness();
    test.emit(completion({ ok: false, errorCode: "LAUNCH_FAILED" }));

    await expect(test.coordinator.awaitExact(EXPECTED)).resolves.toEqual({
      ...EXPECTED,
      ok: false,
      errorCode: "LAUNCH_FAILED"
    });
  });

  it("rejects a mismatched terminal identity without polling", async () => {
    const test = harness();
    const pending = test.coordinator.awaitExact(EXPECTED);

    test.emit(completion({ tabId: "tab-other" }));

    await expect(pending).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_IDENTITY_MISMATCH"
    });
  });

  it("rejects pending event-bound work when the Core stream stops", async () => {
    const test = harness();
    const pending = test.coordinator.awaitExact(EXPECTED);

    test.emit({ type: "shutdown" });

    await expect(pending).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_DISPOSED"
    });
    expect(test.unsubscribe).toHaveBeenCalledOnce();
  });
});
