import { randomUUID } from "node:crypto";

import type { CoreCommand, CoreCommandResult } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumWorkspaceWebNavigationCommit,
  ChromiumWorkspaceWebNavigationCommitPort
} from "./chromiumGlobalWebSurfaceRegistry";

interface WorkspaceWebNavigationCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
}

function reporterError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

/**
 * EventBound: Chromium's successful main-frame navigation events enter this
 * ordered lane exactly once. Closing the lane drains every accepted commit.
 */
export class ChromiumWorkspaceWebNavigationCommitReporter
implements ChromiumWorkspaceWebNavigationCommitPort {
  readonly #core: WorkspaceWebNavigationCorePort;
  readonly #onError: (error: RionBridgeError) => void;
  #accepting = true;
  #tail: Promise<void> = Promise.resolve();

  constructor(input: Readonly<{
    core: WorkspaceWebNavigationCorePort;
    onError: (error: RionBridgeError) => void;
  }>) {
    this.#core = input.core;
    this.#onError = input.onError;
  }

  report(commit: ChromiumWorkspaceWebNavigationCommit): void {
    if (!this.#accepting) return;
    this.#tail = this.#tail.then(async () => {
      const operationId = randomUUID();
      const receipt = await this.#core.invoke({
        type: "browserWorkspaceWebNavigationCommitted",
        operationId,
        surfaceId: commit.surfaceId,
        surfaceGeneration: commit.surfaceGeneration,
        slotId: commit.slotId,
        tabId: commit.tabId,
        windowId: commit.windowId,
        expectedAttemptGeneration: commit.attemptGeneration,
        expectedWindowGeneration: commit.windowGeneration,
        url: commit.url
      });
      if (
        receipt.operationId !== operationId ||
        receipt.windowId !== commit.windowId || receipt.tabId !== commit.tabId ||
        receipt.slotId !== commit.slotId
      ) {
        throw reporterError(
          "ELECTRON_WORKSPACE_WEB_NAVIGATION_RECEIPT_INVALID",
          "Core did not durably acknowledge the exact Workspace Web navigation."
        );
      }
      if (receipt.status === "superseded") {
        if (receipt.durable) {
          throw reporterError(
            "ELECTRON_WORKSPACE_WEB_NAVIGATION_RECEIPT_INVALID",
            "Core returned a durable superseded Workspace Web navigation."
          );
        }
        return;
      }
      const expectedLastUrl = commit.url === "rion-start://home/"
        ? undefined
        : commit.url;
      if (!receipt.durable || receipt.lastUrl !== expectedLastUrl) {
        throw reporterError(
          "ELECTRON_WORKSPACE_WEB_NAVIGATION_RECEIPT_INVALID",
          "Core did not persist the exact Workspace Web continuation URL."
        );
      }
    }).catch((error: unknown) => {
      const normalized = error instanceof RionBridgeError ? error : reporterError(
        "ELECTRON_WORKSPACE_WEB_NAVIGATION_REPORT_FAILED",
        error instanceof Error ? error.message :
          "Core Workspace Web navigation reporting failed."
      );
      try {
        this.#onError(normalized);
      } catch {
        // An observer cannot break the ordered event-bound navigation lane.
      }
    });
  }

  drain(): Promise<void> {
    return this.#tail;
  }

  closeAndDrain(): Promise<void> {
    this.#accepting = false;
    return this.#tail;
  }
}
