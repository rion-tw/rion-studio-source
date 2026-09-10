import { describe, expect, it, vi } from "vitest";

import type { CoreCommand, CoreCommandResult } from "../src/shared/generated";
import { ChromiumWorkspaceWebNavigationCommitReporter } from
  "../src/electron/main/chromiumWorkspaceWebNavigationCommitReporter";
import type { ChromiumWorkspaceWebNavigationCommit } from
  "../src/electron/main/chromiumGlobalWebSurfaceRegistry";

const commit: ChromiumWorkspaceWebNavigationCommit = {
  attemptGeneration: "attempt-web-1",
  surfaceGeneration: 4,
  surfaceId: "web-tab-1-1",
  slotId: "web-slot-1",
  tabId: "tab-web-1",
  url: "https://example.test/path?q=1#part",
  windowGeneration: 7,
  windowId: "window-web-1"
};

class FakeCore {
  readonly commands: CoreCommand[] = [];
  status: "applied" | "unchanged" | "superseded" = "applied";

  async invoke<Command extends CoreCommand>(
    command: Command
  ): Promise<CoreCommandResult<Command>> {
    this.commands.push(command);
    return {
      operationId: "operationId" in command ? command.operationId : "",
      status: this.status,
      durable: this.status !== "superseded",
      windowId: commit.windowId,
      tabId: commit.tabId,
      slotId: commit.slotId,
      lastUrl: "url" in command && command.url === "rion-start://home/"
        ? undefined
        : commit.url
    } as CoreCommandResult<Command>;
  }
}

describe("ChromiumWorkspaceWebNavigationCommitReporter", () => {
  it("reports accepted commits in order and drains them before closing", async () => {
    const core = new FakeCore();
    const onError = vi.fn();
    const reporter = new ChromiumWorkspaceWebNavigationCommitReporter({ core, onError });

    reporter.report(commit);
    reporter.report({ ...commit, url: "rion-start://home/" });
    await reporter.closeAndDrain();
    reporter.report({ ...commit, url: "https://ignored.example.test/" });

    expect(core.commands).toHaveLength(2);
    expect(core.commands.map((command) => command.type)).toEqual([
      "browserWorkspaceWebNavigationCommitted",
      "browserWorkspaceWebNavigationCommitted"
    ]);
    expect(core.commands[0]).toMatchObject({
      surfaceId: commit.surfaceId,
      surfaceGeneration: 4,
      slotId: commit.slotId,
      tabId: commit.tabId,
      windowId: commit.windowId,
      expectedAttemptGeneration: commit.attemptGeneration,
      expectedWindowGeneration: 7,
      url: commit.url
    });
    expect(core.commands[1]).toMatchObject({ url: "rion-start://home/" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("treats a superseded Core receipt as a terminal stale event", async () => {
    const core = new FakeCore();
    core.status = "superseded";
    const onError = vi.fn();
    const reporter = new ChromiumWorkspaceWebNavigationCommitReporter({ core, onError });
    reporter.report(commit);
    await reporter.closeAndDrain();
    expect(onError).not.toHaveBeenCalled();
  });
});
