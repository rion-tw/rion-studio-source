import { describe, expect, it, vi } from "vitest";

import type {
  BrowserWorkspaceWebFailureReceiptRecord,
  CoreCommand,
  CoreCommandResult
} from "../src/shared/generated";
import {
  ChromiumWorkspaceWebNavigationFailureReporter
} from
  "../src/electron/main/chromiumWorkspaceWebNavigationFailureReporter";
import type { ChromiumGlobalWebActiveMainFrameFailure } from
  "../src/electron/main/chromiumGlobalWebSurfaceRegistry";

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

function exactReceipt(): BrowserWorkspaceWebFailureReceiptRecord {
  return {
    operationId: "assigned-by-core", status: "accepted", runtimeRevision: 42,
    windowId: "window-web-1", windowGeneration: 7,
    tabId: "tab-web-1", attemptGeneration: "attempt-web-1",
    surfaceId: "web-tab-1-1", surfaceGeneration: 4
  };
}

class FakeCore {
  readonly commands: CoreCommand[] = [];
  result: BrowserWorkspaceWebFailureReceiptRecord = exactReceipt();
  error: unknown = null;
  echoOperationId = true;

  async invoke<Command extends CoreCommand>(
    command: Command
  ): Promise<CoreCommandResult<Command>> {
    this.commands.push(command);
    if (this.error) throw this.error;
    return { ...this.result, ...(this.echoOperationId ? { operationId: (command as { operationId: string }).operationId } : {}) } as CoreCommandResult<Command>;
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
    core.result.surfaceId = "another-surface";
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
    core.result.status = "superseded";
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

  it.each(["operationId", "status", "windowId", "windowGeneration", "tabId", "attemptGeneration", "surfaceId", "surfaceGeneration", "runtimeRevision"] as const)(
    "rejects a mismatched %s without logging the remote URL", async field => {
      const core = new FakeCore();
      core.echoOperationId = field !== "operationId";
      Object.assign(core.result, { [field]: field === "runtimeRevision" ? -1 : null });
      const onError = vi.fn();
      const onDiagnostic = vi.fn();
      const reporter = new ChromiumWorkspaceWebNavigationFailureReporter({ core, onError, onDiagnostic });
      reporter.report(failure({ validatedUrl: "https://private.test/path?token=secret" }));
      await reporter.closeAndDrain();
      expect(onError).toHaveBeenCalledOnce();
      expect(onDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ invalidFields: [field] }));
      expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("private.test");
      expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("secret");
    }
  );
});
