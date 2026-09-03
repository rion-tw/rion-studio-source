import { randomUUID } from "node:crypto";

import type {
  BrowserRuntimeSnapshot,
  CoreCommand,
  CoreCommandResult
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumGlobalWebActiveMainFrameFailure } from
  "./chromiumGlobalWebSurfaceRegistry";
import type { ChromiumGlobalWebActiveMainFrameFailurePort } from
  "./chromiumGlobalWebSurfaceRegistry";

interface ChromiumWorkspaceWebFailureCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
}

function failureError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function hasExactOwner(
  snapshot: BrowserRuntimeSnapshot,
  failure: ChromiumGlobalWebActiveMainFrameFailure
): boolean {
  const window = snapshot.windows.find((candidate) =>
    candidate.windowId === failure.windowId &&
    candidate.tabIds.includes(failure.tabId)
  );
  const tab = snapshot.tabs.find((candidate) =>
    candidate.id === failure.tabId &&
    candidate.windowId === failure.windowId &&
    candidate.attemptGeneration === failure.attemptGeneration &&
    candidate.webSurfaces.some((surface) =>
      surface.surfaceId === failure.surfaceId
    )
  );
  return window !== undefined && tab !== undefined;
}

/**
 * Serializes exact active-document failures into Rust Core. The Chromium
 * did-fail-load event is authoritative; stale generations terminalize as a
 * superseded observation and never retry toward convergence.
 */
export class ChromiumWorkspaceWebNavigationFailureReporter
implements ChromiumGlobalWebActiveMainFrameFailurePort {
  readonly #core: ChromiumWorkspaceWebFailureCorePort;
  readonly #onError: (error: RionBridgeError) => void;
  #accepting = true;
  #tail: Promise<void> = Promise.resolve();

  constructor(input: Readonly<{
    core: ChromiumWorkspaceWebFailureCorePort;
    onError: (error: RionBridgeError) => void;
  }>) {
    this.#core = input.core;
    this.#onError = input.onError;
  }

  report(failure: ChromiumGlobalWebActiveMainFrameFailure): void {
    if (!this.#accepting) return;
    this.#tail = this.#tail.then(async () => {
      const snapshot = await this.#core.invoke({
        type: "browserWorkspaceWebSurfaceFailed",
        operationId: randomUUID(),
        surfaceId: failure.surfaceId,
        surfaceGeneration: failure.surfaceGeneration,
        tabId: failure.tabId,
        windowId: failure.windowId,
        expectedAttemptGeneration: failure.attemptGeneration,
        expectedWindowGeneration: failure.windowGeneration
      });
      if (!hasExactOwner(snapshot, failure)) {
        throw failureError(
          "ELECTRON_WORKSPACE_WEB_FAILURE_RECEIPT_INVALID",
          "Core did not acknowledge the exact failed Workspace Web surface."
        );
      }
    }).catch((error: unknown) => {
      if (
        typeof error === "object" && error !== null &&
        (error as { code?: unknown }).code ===
          "CHROMIUM_WORKSPACE_WEB_FAILURE_STALE"
      ) {
        return;
      }
      const normalized = error instanceof RionBridgeError ? error : failureError(
        "ELECTRON_WORKSPACE_WEB_FAILURE_REPORT_FAILED",
        error instanceof Error ? error.message :
          "Core Workspace Web failure reporting failed."
      );
      try {
        this.#onError(normalized);
      } catch {
        // An observer cannot break the ordered event-bound failure lane.
      }
    });
  }

  closeAndDrain(): Promise<void> {
    this.#accepting = false;
    return this.#tail;
  }
}
