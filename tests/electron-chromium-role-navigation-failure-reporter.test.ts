import { describe, expect, it, vi } from "vitest";

import type {
  BrowserRoleStatusRecord,
  CoreCommand,
  CoreCommandResult
} from "../src/shared/generated";
import {
  ChromiumRoleNavigationFailureReporter,
  type ChromiumRoleActiveMainFrameFailure
} from "../src/electron/main/chromiumRoleNavigationFailureReporter";
import { RionBridgeError } from "../src/electron/ipc/errors";

class FakeCore {
  readonly commands: CoreCommand[] = [];
  statuses: BrowserRoleStatusRecord[] = [{
    roleId: "role-1",
    state: "running",
    runtimeMode: "embedded",
    issueReason: "runtime-crashed"
  }];
  error: unknown = null;

  async invoke<Command extends CoreCommand>(
    command: Command
  ): Promise<CoreCommandResult<Command>> {
    this.commands.push(command);
    if (this.error) throw this.error;
    return this.statuses as unknown as CoreCommandResult<Command>;
  }
}

function failure(
  overrides: Partial<ChromiumRoleActiveMainFrameFailure> = {}
): ChromiumRoleActiveMainFrameFailure {
  return {
    errorCode: -105,
    roleId: "role-1",
    surfaceGeneration: 3,
    tabId: "tab-1",
    validatedUrl: "https://game.test/offline",
    ...overrides
  };
}

describe("ChromiumRoleNavigationFailureReporter", () => {
  it("reports the exact live generation once through the existing Core failure event", async () => {
    const core = new FakeCore();
    const onError = vi.fn();
    const reporter = new ChromiumRoleNavigationFailureReporter({
      core,
      currentSurface: () => ({
        ownerGeneration: 7,
        roleId: "role-1",
        surfaceGeneration: 3,
        tabId: "tab-1"
      }),
      onError
    });

    reporter.report(failure());
    await reporter.closeAndDrain();

    expect(core.commands).toEqual([{
      type: "embeddedSystemSurfaceFailed",
      roleId: "role-1",
      reason: "surface.navigation-failed",
      expectedTabId: "tab-1",
      expectedOwnerGeneration: 7
    }]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("terminally cancels a queued failure after its surface generation is stale", async () => {
    const core = new FakeCore();
    const reporter = new ChromiumRoleNavigationFailureReporter({
      core,
      currentSurface: () => ({
        ownerGeneration: 7,
        roleId: "role-1",
        surfaceGeneration: 4,
        tabId: "tab-1"
      }),
      onError: vi.fn()
    });

    reporter.report(failure({ surfaceGeneration: 3 }));
    await reporter.closeAndDrain();

    expect(core.commands).toEqual([]);
  });

  it("fails closed when Core omits the exact runtime-crashed receipt", async () => {
    const core = new FakeCore();
    core.statuses = [];
    const onError = vi.fn();
    const reporter = new ChromiumRoleNavigationFailureReporter({
      core,
      currentSurface: () => ({
        ownerGeneration: 7,
        roleId: "role-1",
        surfaceGeneration: 3,
        tabId: "tab-1"
      }),
      onError
    });

    reporter.report(failure());
    await reporter.closeAndDrain();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_ROLE_NAVIGATION_FAILURE_RECEIPT_INVALID"
    }));
  });

  it("treats Core owner supersession as terminal instead of a shell error", async () => {
    const core = new FakeCore();
    core.error = new RionBridgeError({
      code: "RUNTIME_ROLE_OWNER_STALE",
      message: "The Role moved while failure reporting was queued."
    });
    const onError = vi.fn();
    const reporter = new ChromiumRoleNavigationFailureReporter({
      core,
      currentSurface: () => ({
        ownerGeneration: 7,
        roleId: "role-1",
        surfaceGeneration: 3,
        tabId: "tab-1"
      }),
      onError
    });

    reporter.report(failure());
    await reporter.closeAndDrain();

    expect(core.commands).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
