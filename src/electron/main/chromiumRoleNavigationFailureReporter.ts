import type {
  BrowserRoleStatusRecord,
  CoreCommand,
  CoreCommandResult
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";

export interface ChromiumRoleActiveMainFrameFailure {
  readonly errorCode: number;
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly tabId: string;
  readonly validatedUrl: string;
}

export interface ChromiumRoleActiveMainFrameFailurePort {
  report: (failure: ChromiumRoleActiveMainFrameFailure) => void;
}

interface ChromiumRoleNavigationFailureCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
}

interface CurrentRoleSurfaceIdentity {
  readonly ownerGeneration: number;
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly tabId: string;
}

function reporterError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function isExactFailureStatus(
  statuses: readonly BrowserRoleStatusRecord[],
  roleId: string
): boolean {
  return statuses.some((status) =>
    status.roleId === roleId && status.state === "running" &&
    status.issueReason === "runtime-crashed"
  );
}

/**
 * Serializes authoritative active-document failures into Core. A superseded
 * Chromium generation is a terminal cancellation, never a retry trigger.
 */
export class ChromiumRoleNavigationFailureReporter
implements ChromiumRoleActiveMainFrameFailurePort {
  readonly #core: ChromiumRoleNavigationFailureCorePort;
  readonly #currentSurface: (
    roleId: string
  ) => CurrentRoleSurfaceIdentity | null;
  readonly #onError: (error: RionBridgeError) => void;
  #accepting = true;
  #tail: Promise<void> = Promise.resolve();

  constructor(input: Readonly<{
    core: ChromiumRoleNavigationFailureCorePort;
    currentSurface: (roleId: string) => CurrentRoleSurfaceIdentity | null;
    onError: (error: RionBridgeError) => void;
  }>) {
    this.#core = input.core;
    this.#currentSurface = input.currentSurface;
    this.#onError = input.onError;
  }

  report(failure: ChromiumRoleActiveMainFrameFailure): void {
    if (!this.#accepting) return;
    this.#tail = this.#tail.then(async () => {
      const current = this.#currentSurface(failure.roleId);
      if (
        !current || current.roleId !== failure.roleId ||
        current.tabId !== failure.tabId ||
        current.surfaceGeneration !== failure.surfaceGeneration
      ) {
        return;
      }
      const statuses = await this.#core.invoke({
        type: "embeddedSystemSurfaceFailed",
        roleId: failure.roleId,
        reason: "surface.navigation-failed",
        expectedTabId: current.tabId,
        expectedOwnerGeneration: current.ownerGeneration
      });
      if (!isExactFailureStatus(statuses, failure.roleId)) {
        throw reporterError(
          "ELECTRON_ROLE_NAVIGATION_FAILURE_RECEIPT_INVALID",
          "Core did not acknowledge the exact failed Chromium Role surface."
        );
      }
    }).catch((error: unknown) => {
      if (
        typeof error === "object" && error !== null &&
        (error as { code?: unknown }).code === "RUNTIME_ROLE_OWNER_STALE"
      ) {
        return;
      }
      const normalized = error instanceof RionBridgeError ? error : reporterError(
        "ELECTRON_ROLE_NAVIGATION_FAILURE_REPORT_FAILED",
        error instanceof Error ? error.message : "Core failure reporting failed."
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
