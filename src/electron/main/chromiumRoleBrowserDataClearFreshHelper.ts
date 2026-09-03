import { createHash, randomUUID } from "node:crypto";

import { RionBridgeError } from "../ipc/errors";
import {
  type ChromiumRoleBrowserDataMaintenanceLease
} from "./chromiumRoleBrowserDataClearCoordinator";
import {
  chromiumRoleBrowserDataClearFreshHelperResponseMetadata,
  type ChromiumRoleBrowserDataClearFreshHelperRequest
} from "./chromiumRoleBrowserDataClearFreshHelperContract";
import {
  ChromiumRoleSessionRegistry,
  type ChromiumSessionFactoryPort
} from "./chromiumRoleSessionRegistry";
import { ChromiumSessionOwnershipLedger } from
  "./chromiumSessionOwnershipLedger";

export interface ChromiumRoleBrowserDataClearFreshHelperInput {
  readonly platform: "darwin" | "win32";
  readonly sessions: ChromiumSessionFactoryPort;
}

export interface ChromiumRoleBrowserDataClearFreshHelperResult {
  readonly outcome: "applied" | "failed" | "indeterminate";
  readonly metadataBytes: Buffer;
  readonly secretBytes: Buffer;
}

function helperError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function promiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof (value as { then?: unknown }).then === "function";
}

function stableErrorCode(error: unknown): string {
  return error instanceof RionBridgeError &&
    /^CHROMIUM_ROLE_BROWSER_DATA_CLEAR_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_FAILED";
}

function drainEvidence(
  request: ChromiumRoleBrowserDataClearFreshHelperRequest,
  processInstanceId: string
): string {
  return createHash("sha256").update([
    "rion-role-browser-data-clear-fresh-drain-v1",
    request.evidenceRevision,
    request.platform,
    request.effectId,
    request.operationId,
    request.roleId,
    request.chromiumPathSha256,
    processInstanceId,
    process.pid
  ].join("\0"), "utf8").digest("hex");
}

/**
 * Runs only inside the fixed-mode helper process. Chromium's all-store clear
 * Promise is the LocalStorage authority; cookies additionally flush and read
 * back empty. The caller accepts this response only after native clean exit and
 * inherited-pipe EOF prove that this helper's exact Session was drained.
 */
export class ChromiumRoleBrowserDataClearFreshHelper {
  readonly #input: ChromiumRoleBrowserDataClearFreshHelperInput;

  constructor(input: ChromiumRoleBrowserDataClearFreshHelperInput) {
    this.#input = input;
  }

  async run(
    request: ChromiumRoleBrowserDataClearFreshHelperRequest,
    secretBytes: Buffer
  ): Promise<ChromiumRoleBrowserDataClearFreshHelperResult> {
    const ownership = new ChromiumSessionOwnershipLedger(this.#input.platform);
    const registry = new ChromiumRoleSessionRegistry(
      this.#input.sessions,
      this.#input.platform,
      ownership
    );
    let lease: ChromiumRoleBrowserDataMaintenanceLease | null = null;
    let mutationStarted = false;
    let releaseUnknown = false;
    try {
      if (secretBytes.byteLength !== 0) {
        throw helperError(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_SECRET_INVALID",
          "The browser-data clear helper does not accept secret payload bytes."
        );
      }
      if (request.platform !== this.#input.platform) {
        throw helperError(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_PLATFORM_MISMATCH",
          "The helper process platform does not match the clear operation."
        );
      }
      const acquisition = registry.acquireRoleBrowserDataMaintenance({
        roleId: request.roleId,
        operationId: request.operationId,
        rolePaths: request.rolePaths
      });
      if (acquisition.status !== "acquired") {
        throw helperError(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_LEASE_REJECTED",
          "The fresh helper could not acquire its exact role Session."
        );
      }
      lease = acquisition.lease;

      mutationStarted = true;
      const clearing = lease.session.clearStorageData();
      if (!promiseLike(clearing)) {
        throw helperError(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_CLEAR_ACK_UNAVAILABLE",
          "Chromium did not expose the all-store clear acknowledgement."
        );
      }
      try {
        await clearing;
      } catch {
        throw helperError(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_CLEAR_ACK_INDETERMINATE",
          "Chromium's all-store clear acknowledgement was lost."
        );
      }

      const flushing = lease.session.cookies.flushStore();
      if (!promiseLike(flushing)) {
        throw helperError(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_COOKIE_FLUSH_UNAVAILABLE",
          "Chromium did not expose the cookie-store flush acknowledgement."
        );
      }
      try {
        await flushing;
      } catch {
        throw helperError(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_COOKIE_FLUSH_INDETERMINATE",
          "Chromium's cookie-store flush acknowledgement was lost."
        );
      }

      const reading = lease.session.cookies.get({});
      if (!promiseLike(reading)) {
        throw helperError(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_COOKIE_READBACK_UNAVAILABLE",
          "Chromium did not expose the all-cookie readback acknowledgement."
        );
      }
      let cookies;
      try {
        cookies = await reading;
      } catch {
        throw helperError(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_COOKIE_READBACK_INDETERMINATE",
          "Chromium's all-cookie readback acknowledgement was lost."
        );
      }
      if (!Array.isArray(cookies)) {
        throw helperError(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_COOKIE_READBACK_INVALID",
          "Chromium returned a non-canonical all-cookie readback."
        );
      }
      if (cookies.length !== 0) {
        throw helperError(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_COOKIE_READBACK_NONEMPTY",
          "The freshly reopened role Session still contains cookies."
        );
      }

      const released = await registry.releaseRoleBrowserDataMaintenance(lease);
      if (!released) {
        throw helperError(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_RELEASE_INDETERMINATE",
          "The fresh helper could not prove exact native Session release."
        );
      }
      lease = null;
      await registry.dispose();

      const processInstanceId = randomUUID();
      return Object.freeze({
        outcome: "applied",
        metadataBytes: chromiumRoleBrowserDataClearFreshHelperResponseMetadata(
          request,
          {
            cookieReadbackCount: 0,
            storageClearAcknowledgement:
              "electron-clear-storage-data-promise",
            processInstanceId,
            sessionDrainEvidenceSha256: drainEvidence(
              request,
              processInstanceId
            )
          }
        ),
        secretBytes: Buffer.alloc(0)
      });
    } catch (error) {
      if (lease) {
        try {
          await registry.releaseRoleBrowserDataMaintenance(lease);
          lease = null;
        } catch {
          releaseUnknown = true;
        }
      }
      return Object.freeze({
        outcome: mutationStarted || releaseUnknown ? "indeterminate" : "failed",
        metadataBytes: chromiumRoleBrowserDataClearFreshHelperResponseMetadata(
          request,
          {
            stableErrorCode: releaseUnknown
              ? "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_RELEASE_INDETERMINATE"
              : stableErrorCode(error)
          }
        ),
        secretBytes: Buffer.alloc(0)
      });
    } finally {
      secretBytes.fill(0);
    }
  }
}
