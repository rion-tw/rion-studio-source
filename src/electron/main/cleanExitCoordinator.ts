import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";
import type { ElectronCleanExitFailure } from "./lifecycle";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";

export const ROLE_BROWSER_DATA_CLEAR_COMMAND_DRAIN_TIMEOUT_MS = 30_000;

const PRETERMINAL_CHECKED_SHUTDOWN_CODES = new Set([
  "CHROME_PROFILE_IMPORT_HELPER_REGISTRY_FAILED",
  "CORE_SHUTDOWN_BROWSER_OPERATIONS_UNVERIFIED",
  "CORE_SHUTDOWN_PRETERMINAL_UNVERIFIED",
  "CORE_SHUTDOWN_ROLE_BROWSER_DATA_CLEAR_UNVERIFIED"
]);
const PROVEN_LATE_CHECKED_SHUTDOWN_CODES = new Set([
  "CORE_LOG_DATABASE_FAILED",
  "CORE_SHUTTING_DOWN",
  "CORE_SHUTDOWN_INSTANCE_LOCK_UNVERIFIED",
  "CORE_SHUTDOWN_RUNTIME_UNVERIFIED",
  "CORE_STATE_DATABASE_FAILED"
]);

export interface ElectronCleanExitCorePort {
  beginRoleBrowserDataClearCommandDrain: () => void;
  waitForRoleBrowserDataClearCommandDrain: (timeoutMs: number) => Promise<boolean>;
  invalidateRuntimeRestoreSessionCleanExitInternal: () => Promise<void>;
}

export interface ElectronCleanExitRuntimePort {
  beginCleanExit: () => void;
  prepareCleanExit: (
    persist: (snapshot: ChromiumRuntimeExecutorSnapshot) => Promise<unknown>
  ) => Promise<void>;
}

export interface ElectronCleanExitCoordinatorInput {
  core: ElectronCleanExitCorePort;
  runtime: ElectronCleanExitRuntimePort | null;
  rendererIngress: { closeAndDrain: () => Promise<void> } | null;
  releaseRendererIngress: () => void;
  persistCleanExit: (snapshot: ChromiumRuntimeExecutorSnapshot) => Promise<unknown>;
  clearCommandDrainTimeoutMs?: number;
}

/**
 * A clean boundary or fatal fence always invalidates. Once the boundary is
 * persisted, only stable Core codes whose call sites occur after both browser
 * prechecks may retain it; unknown/transport failures remain fail-closed.
 */
export function cleanExitFailureRequiresInvalidation(
  failure: ElectronCleanExitFailure
): boolean {
  if (
    failure.fatalGenerationInvalidated ||
    !failure.cleanBoundaryPersisted ||
    failure.phase !== "checkedCoreShutdown"
  ) {
    return true;
  }
  const code = typeof failure.error === "object" && failure.error !== null
    && typeof (failure.error as { code?: unknown }).code === "string"
    ? (failure.error as { code: string }).code
    : null;
  if (!code || PRETERMINAL_CHECKED_SHUTDOWN_CODES.has(code)) return true;
  return !PROVEN_LATE_CHECKED_SHUTDOWN_CODES.has(code);
}

/**
 * Closes every general command ingress synchronously, then drains admitted
 * renderer/native/effect/helper work. The clean journal is persisted only
 * after Rust proves every pre-fence browser-data clear command terminal.
 */
export function prepareElectronCleanExit(
  input: ElectronCleanExitCoordinatorInput
): Promise<void> {
  let rendererDrain: Promise<void>;
  let fenceFailure: unknown;
  let fenceFailed = false;
  try {
    input.core.beginRoleBrowserDataClearCommandDrain();
  } catch (error) {
    fenceFailed = true;
    fenceFailure = error;
  }
  try {
    if (!input.runtime) {
      throw new RionBridgeError({
        code: "ELECTRON_CHROMIUM_RUNTIME_UNAVAILABLE",
        message: "The Chromium runtime cannot prepare a clean exit."
      });
    }
    input.runtime.beginCleanExit();
  } catch (error) {
    if (!fenceFailed) fenceFailure = error;
    fenceFailed = true;
  }
  try {
    input.releaseRendererIngress();
    rendererDrain = input.rendererIngress?.closeAndDrain() ?? Promise.resolve();
  } catch (error) {
    if (!fenceFailed) fenceFailure = error;
    fenceFailed = true;
    rendererDrain = Promise.resolve();
  }
  if (fenceFailed) {
    void rendererDrain.catch(() => undefined);
    return Promise.reject(fenceFailure);
  }
  const runtime = input.runtime!;
  const clean = rendererDrain.then(() => runtime.prepareCleanExit(async (snapshot) => {
    const drained = await input.core.waitForRoleBrowserDataClearCommandDrain(
      input.clearCommandDrainTimeoutMs
        ?? ROLE_BROWSER_DATA_CLEAR_COMMAND_DRAIN_TIMEOUT_MS
    );
    if (!drained) {
      throw new RionBridgeError({
        code: "ELECTRON_ROLE_BROWSER_DATA_CLEAR_DRAIN_INDETERMINATE",
        message: "A role browser-data clear command did not terminalize before clean exit."
      });
    }
    await input.persistCleanExit(snapshot);
  }));
  return clean.catch(async (error: unknown) => {
    // This replay is deliberately issued after a failed persist Promise has
    // settled, so it linearizes after any clean=true mutation already sent.
    await input.core.invalidateRuntimeRestoreSessionCleanExitInternal();
    throw error;
  });
}

export async function terminateAfterCleanExitFailure(
  failure: ElectronCleanExitFailure,
  core: Pick<ElectronCleanExitCorePort,
    "invalidateRuntimeRestoreSessionCleanExitInternal">,
  forceTerminate: () => Promise<unknown>,
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void
): Promise<void> {
  if (cleanExitFailureRequiresInvalidation(failure)) {
    try {
      await core.invalidateRuntimeRestoreSessionCleanExitInternal();
    } catch (error) {
      try {
        onError(normalizeRionBridgeError(
          error,
          "ELECTRON_RUNTIME_RESTORE_UNCLEAN_INVALIDATION_FAILED"
        ));
      } catch {
        // Error presentation cannot suppress the mandatory nonzero termination.
      }
    }
  }
  await forceTerminate();
}
