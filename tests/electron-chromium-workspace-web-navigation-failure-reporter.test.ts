import { describe, expect, it, vi } from "vitest";

import type {
  BrowserRuntimeSnapshot,
  CoreCommand,
  CoreCommandResult
} from "../src/shared/generated";
import {
  ChromiumWorkspaceWebNavigationFailureReporter
} from
  "../src/electron/main/chromiumWorkspaceWebNavigationFailureReporter";
import type { ChromiumGlobalWebActiveMainFrameFailure } from
  "../src/electron/main/chromiumGlobalWebSurfaceRegistry";
import { RionBridgeError } from "../src/electron/ipc/errors";

function failure(
  overrides: Partial<ChromiumGlobalWebActiveMainFrameFailure> = {}
): ChromiumGlobalWebActiveMainFrameFailure {
  return {
    attemptGeneration: "attempt-web-1",
    errorCode: -105,
    surfaceGeneration: 4,
    surfaceId: "web-tab-1-1",
    tabId: "tab-web-1",
    validatedUrl: "https://offline.example.test/",
    windowGeneration: 7,
    windowId: "window-web-1",
    ...overrides
  };
}

function exactSnapshot(
  overrides: Partial<BrowserRuntimeSnapshot> = {}
): BrowserRuntimeSnapshot {
  return {
    windows: [{
      windowId: "window-web-1",
      activeTabId: "tab-web-1",
      tabIds: ["tab-web-1"]
    }],
    roles: [],
    tabs: [{
      id: "tab-web-1",
      audioMuted: false,
      attemptGeneration: "attempt-web-1",
      sourceId: "workspace-1",
      name: "Web Workspace",
      windowId: "window-web-1",
      tabType: "workspace",
      workspaceId: "workspace-1",
      slots: [],
      webSurfaces: [{
        surfaceId: "web-tab-1-1",
        slotId: "web-slot-1"
      }],
      hidden: false
    }],
    workspaces: [],
    ...overrides
  };
}

class FakeCore {
  readonly commands: CoreCommand[] = [];
  result: BrowserRuntimeSnapshot = exactSnapshot();
  error: unknown = null;

  async invoke<Command extends CoreCommand>(
    command: Command
  ): Promise<CoreCommandResult<Command>> {
    this.commands.push(command);
    if (this.error) throw this.error;
    return this.result as CoreCommandResult<Command>;
  }
}

describe("ChromiumWorkspaceWebNavigationFailureReporter", () => {
  it("reports the exact generation-fenced Workspace Web failure to Core", async () => {
    const core = new FakeCore();
    const onError = vi.fn();
    const reporter = new ChromiumWorkspaceWebNavigationFailureReporter({
      core,
      onError
    });

    reporter.report(failure());
    await reporter.closeAndDrain();

    expect(core.commands).toHaveLength(1);
    expect(core.commands[0]).toMatchObject({
      type: "browserWorkspaceWebSurfaceFailed",
      surfaceId: "web-tab-1-1",
      surfaceGeneration: 4,
      tabId: "tab-web-1",
      windowId: "window-web-1",
      expectedAttemptGeneration: "attempt-web-1",
      expectedWindowGeneration: 7
    });
    expect(core.commands[0]).toMatchObject({ operationId: expect.any(String) });
    expect(onError).not.toHaveBeenCalled();
  });

  it("fails closed when Core omits the exact failed surface receipt", async () => {
    const core = new FakeCore();
    core.result = exactSnapshot({ tabs: [] });
    const onError = vi.fn();
    const reporter = new ChromiumWorkspaceWebNavigationFailureReporter({
      core,
      onError
    });

    reporter.report(failure());
    await reporter.closeAndDrain();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_WORKSPACE_WEB_FAILURE_RECEIPT_INVALID"
    }));
  });

  it("treats Core ownership supersession as terminal", async () => {
    const core = new FakeCore();
    core.error = new RionBridgeError({
      code: "CHROMIUM_WORKSPACE_WEB_FAILURE_STALE",
      message: "The Workspace Web surface moved before failure commit."
    });
    const onError = vi.fn();
    const reporter = new ChromiumWorkspaceWebNavigationFailureReporter({
      core,
      onError
    });

    reporter.report(failure());
    await reporter.closeAndDrain();

    expect(core.commands).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
