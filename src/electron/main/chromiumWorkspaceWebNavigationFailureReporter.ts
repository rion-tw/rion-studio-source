import { randomUUID } from "node:crypto";

import type {
  BrowserWorkspaceWebFailureReceiptRecord,
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

function invalidReceiptFields(
  receipt: BrowserWorkspaceWebFailureReceiptRecord,
  failure: ChromiumGlobalWebActiveMainFrameFailure,
  operationId: string
): string[] {
  const expected = {
    operationId, windowId: failure.windowId, windowGeneration: failure.windowGeneration,
    tabId: failure.tabId, attemptGeneration: failure.attemptGeneration,
    surfaceId: failure.surfaceId, surfaceGeneration: failure.surfaceGeneration
  };
  const invalid = Object.entries(expected).filter(([key, value]) =>
    receipt?.[key as keyof typeof expected] !== value
  ).map(([key]) => key);
  if (!["accepted", "superseded"].includes(receipt?.status)) invalid.push("status");
  if (!Number.isSafeInteger(receipt?.runtimeRevision) || receipt.runtimeRevision < 0) invalid.push("runtimeRevision");
  return invalid;
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
  readonly #onDiagnostic: (context: Readonly<Record<string, unknown>>) => void;
  #accepting = true;
  #tail: Promise<void> = Promise.resolve();

  constructor(input: Readonly<{
    core: ChromiumWorkspaceWebFailureCorePort;
    onError: (error: RionBridgeError) => void;
    onDiagnostic?: (context: Readonly<Record<string, unknown>>) => void;
  }>) {
    this.#core = input.core;
    this.#onError = input.onError;
    this.#onDiagnostic = input.onDiagnostic ?? (() => undefined);
  }

  report(failure: ChromiumGlobalWebActiveMainFrameFailure): void {
    if (!this.#accepting) return;
    this.#tail = this.#tail.then(async () => {
      const operationId = randomUUID();
      const diagnostic = {
        operationId, surfaceId: failure.surfaceId, surfaceGeneration: failure.surfaceGeneration,
        tabId: failure.tabId, windowId: failure.windowId, windowGeneration: failure.windowGeneration,
        attemptGeneration: failure.attemptGeneration, navigationErrorCode: failure.errorCode,
        eventSource: failure.source ?? "did-fail-load",
        ...(failure.networkError === undefined ? {} : { networkError: failure.networkError })
      };
      this.#onDiagnostic({ ...diagnostic, stage: "observed" });
      const receipt = await this.#core.invoke({
        type: "browserWorkspaceWebSurfaceFailed",
        operationId,
        surfaceId: failure.surfaceId,
        surfaceGeneration: failure.surfaceGeneration,
        tabId: failure.tabId,
        windowId: failure.windowId,
        expectedAttemptGeneration: failure.attemptGeneration,
        expectedWindowGeneration: failure.windowGeneration
      });
      const invalidFields = invalidReceiptFields(receipt, failure, operationId);
      this.#onDiagnostic({ ...diagnostic, stage: invalidFields.length ? "invalid-receipt" : receipt.status,
        invalidFields, runtimeRevision: receipt?.runtimeRevision });
      if (invalidFields.length) {
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
