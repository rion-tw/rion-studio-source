import {
  chromiumPathApi as pathApi,
  chromiumPathKey as pathKey,
  chromiumPathSegmentEquals as fixedSegmentEquals,
  canonicalChromiumPath as canonicalPath
} from "./chromiumSessionPath";

import type { GlobalWebProfilePathsRecord } from "../../shared/generated";
import {
  CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES
} from "./chromiumRoleBrowserDataClearCoordinator";
import type {
  ChromiumGlobalWebMaintenanceAcquireResult,
  ChromiumGlobalWebMaintenanceLease
} from "./chromiumGlobalWebSessionRegistry";
import type { ChromiumRoleSessionPort } from "./chromiumRoleSessionRegistry";

type SupportedPlatform = "darwin" | "win32";

export interface ChromiumGlobalWebBrowserDataClearInput {
  readonly operationId: string;
  readonly profile: GlobalWebProfilePathsRecord;
}

export interface ChromiumGlobalWebBrowserDataMaintenancePort {
  acquire: (
    operationId: string,
    profile: GlobalWebProfilePathsRecord
  ) => ChromiumGlobalWebMaintenanceAcquireResult;
  release: (lease: ChromiumGlobalWebMaintenanceLease) => Promise<boolean>;
}

export type ChromiumGlobalWebBrowserDataClearResult =
  | Readonly<{
      status: "applied";
      receipt: Readonly<{
        profileKey: "global-web";
        operationId: string;
        clearedStorages: typeof CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES;
        cookieReadbackCount: 0;
        evidence: "electron-clear-storage-data-promise-and-cookie-readback";
      }>;
    }>
  | Readonly<{
      status: "failed";
      stableErrorCode: string;
      mutation: "not-started" | "partial";
    }>
  | Readonly<{
      status: "indeterminate";
      stableErrorCode: string;
      mutation: "unknown";
    }>;

interface ClearSnapshot {
  readonly operationId: string;
  readonly profile: GlobalWebProfilePathsRecord;
  readonly chromiumPath: string;
  readonly pathKey: string;
  readonly identityKey: string;
}

interface ClearLane {
  readonly identityKey: string;
  readonly promise: Promise<ChromiumGlobalWebBrowserDataClearResult>;
}

type Preflight =
  | Readonly<{ ok: true; snapshot: ClearSnapshot }>
  | Readonly<{ ok: false; result: ChromiumGlobalWebBrowserDataClearResult }>;

function failed(
  stableErrorCode: string,
  mutation: "not-started" | "partial" = "not-started"
): ChromiumGlobalWebBrowserDataClearResult {
  return Object.freeze({ status: "failed", stableErrorCode, mutation });
}

function indeterminate(
  stableErrorCode: string
): ChromiumGlobalWebBrowserDataClearResult {
  return Object.freeze({
    status: "indeterminate",
    stableErrorCode,
    mutation: "unknown"
  });
}

function preflight(
  input: ChromiumGlobalWebBrowserDataClearInput,
  platform: SupportedPlatform
): Preflight {
  if (
    !input || typeof input !== "object" ||
    typeof input.operationId !== "string" || input.operationId.length === 0 ||
    input.operationId.length > 160 ||
    input.operationId !== input.operationId.trim() ||
    [...input.operationId].some((character) => character.codePointAt(0)! <= 0x1f) ||
    input.profile?.profileKey !== "global-web"
  ) {
    return Object.freeze({
      ok: false,
      result: failed("CHROMIUM_GLOBAL_WEB_DATA_CLEAR_IDENTITY_INVALID")
    });
  }
  const chromiumPath = canonicalPath(
    input.profile.chromiumUserDataDir,
    platform
  );
  if (!chromiumPath) {
    return Object.freeze({
      ok: false,
      result: failed("CHROMIUM_GLOBAL_WEB_DATA_CLEAR_PATH_INVALID")
    });
  }
  const paths = pathApi(platform);
  const profileDirectory = paths.dirname(chromiumPath);
  const profilesDirectory = paths.dirname(profileDirectory);
  if (
    !fixedSegmentEquals(paths.basename(chromiumPath), "chromium", platform) ||
    !fixedSegmentEquals(paths.basename(profileDirectory), "global-web", platform) ||
    !fixedSegmentEquals(paths.basename(profilesDirectory), "web-profiles", platform)
  ) {
    return Object.freeze({
      ok: false,
      result: failed("CHROMIUM_GLOBAL_WEB_DATA_CLEAR_PATH_MISMATCH")
    });
  }
  const key = pathKey(chromiumPath, platform);
  const profile = Object.freeze({ ...input.profile });
  const snapshot = Object.freeze({
    operationId: input.operationId,
    profile,
    chromiumPath,
    pathKey: key,
    identityKey: JSON.stringify([input.operationId, key])
  });
  return Object.freeze({ ok: true, snapshot });
}

function promiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof (value as { then?: unknown }).then === "function";
}

function rejectionCode(
  reason: Exclude<
    ChromiumGlobalWebMaintenanceAcquireResult,
    { status: "acquired" }
  >["reason"]
): string {
  switch (reason) {
    case "active-surface":
      return "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_SESSION_ACTIVE";
    case "active-maintenance":
      return "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_OPERATION_CONFLICT";
    case "draining":
      return "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_REGISTRY_DRAINING";
    case "path-conflict":
      return "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_PATH_CONFLICT";
    case "releasing":
      return "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_SESSION_RELEASING";
    default:
      return "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_LEASE_ACQUIRE_FAILED";
  }
}

function leaseMatches(
  lease: ChromiumGlobalWebMaintenanceLease,
  snapshot: ClearSnapshot,
  platform: SupportedPlatform
): boolean {
  const nativePath = canonicalPath(lease?.session?.storagePath, platform);
  return lease?.profileKey === "global-web" &&
    lease.operationId === snapshot.operationId &&
    lease.chromiumUserDataDir === snapshot.chromiumPath &&
    nativePath !== null && pathKey(nativePath, platform) === snapshot.pathKey;
}

/**
 * Clears only the Rust-owned shared workspace Web profile. Admission is an
 * exclusive registry lease, and success requires Chromium's clear Promise,
 * cookie-store flush, empty cookie readback, and exact lease release.
 */
export class ChromiumGlobalWebBrowserDataClearCoordinator {
  readonly #maintenance: ChromiumGlobalWebBrowserDataMaintenancePort;
  readonly #platform: SupportedPlatform;
  #lane: ClearLane | null = null;

  constructor(input: Readonly<{
    maintenance: ChromiumGlobalWebBrowserDataMaintenancePort;
    platform: SupportedPlatform;
  }>) {
    this.#maintenance = input.maintenance;
    this.#platform = input.platform;
  }

  clear(
    input: ChromiumGlobalWebBrowserDataClearInput
  ): Promise<ChromiumGlobalWebBrowserDataClearResult> {
    const checked = preflight(input, this.#platform);
    if (!checked.ok) return Promise.resolve(checked.result);
    const { snapshot } = checked;
    if (this.#lane) {
      return this.#lane.identityKey === snapshot.identityKey
        ? this.#lane.promise
        : Promise.resolve(failed(
          "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_OPERATION_CONFLICT"
        ));
    }
    const promise = this.#clear(snapshot).finally(() => {
      if (this.#lane?.promise === promise) this.#lane = null;
    });
    this.#lane = { identityKey: snapshot.identityKey, promise };
    return promise;
  }

  async #clear(
    snapshot: ClearSnapshot
  ): Promise<ChromiumGlobalWebBrowserDataClearResult> {
    let acquisition: ChromiumGlobalWebMaintenanceAcquireResult;
    try {
      acquisition = this.#maintenance.acquire(
        snapshot.operationId,
        snapshot.profile
      );
    } catch {
      return failed("CHROMIUM_GLOBAL_WEB_DATA_CLEAR_LEASE_ACQUIRE_FAILED");
    }
    if (acquisition.status !== "acquired") {
      return failed(rejectionCode(acquisition.reason));
    }
    const { lease } = acquisition;
    let result: ChromiumGlobalWebBrowserDataClearResult;
    try {
      result = leaseMatches(lease, snapshot, this.#platform)
        ? await this.#clearLease(lease)
        : failed("CHROMIUM_GLOBAL_WEB_DATA_CLEAR_LEASE_INVALID");
    } catch {
      result = indeterminate(
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_EXECUTION_INDETERMINATE"
      );
    }

    let release: Promise<boolean>;
    try {
      release = this.#maintenance.release(lease);
    } catch {
      return indeterminate("CHROMIUM_GLOBAL_WEB_DATA_CLEAR_RELEASE_INDETERMINATE");
    }
    if (!promiseLike(release)) {
      return indeterminate("CHROMIUM_GLOBAL_WEB_DATA_CLEAR_RELEASE_INDETERMINATE");
    }
    try {
      if (await release !== true) {
        return indeterminate(
          "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_RELEASE_INDETERMINATE"
        );
      }
    } catch {
      return indeterminate("CHROMIUM_GLOBAL_WEB_DATA_CLEAR_RELEASE_INDETERMINATE");
    }
    return result;
  }

  async #clearLease(
    lease: ChromiumGlobalWebMaintenanceLease
  ): Promise<ChromiumGlobalWebBrowserDataClearResult> {
    let clearing: Promise<void>;
    try {
      clearing = lease.session.clearStorageData({
        storages: [...CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES]
      });
    } catch {
      return failed("CHROMIUM_GLOBAL_WEB_DATA_CLEAR_SUBMISSION_FAILED");
    }
    if (!promiseLike(clearing)) {
      return indeterminate(
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_ACKNOWLEDGEMENT_UNAVAILABLE"
      );
    }
    try {
      await clearing;
    } catch {
      return indeterminate(
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_ACKNOWLEDGEMENT_INDETERMINATE"
      );
    }
    let flushing: Promise<void>;
    try {
      flushing = lease.session.cookies.flushStore();
    } catch {
      return indeterminate(
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_COOKIE_FLUSH_INDETERMINATE"
      );
    }
    if (!promiseLike(flushing)) {
      return indeterminate(
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_COOKIE_FLUSH_INDETERMINATE"
      );
    }
    try {
      await flushing;
    } catch {
      return indeterminate(
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_COOKIE_FLUSH_INDETERMINATE"
      );
    }
    let readback: ReturnType<ChromiumRoleSessionPort["cookies"]["get"]>;
    try {
      readback = lease.session.cookies.get({});
    } catch {
      return indeterminate(
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_COOKIE_READBACK_INDETERMINATE"
      );
    }
    if (!promiseLike(readback)) {
      return indeterminate(
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_COOKIE_READBACK_INDETERMINATE"
      );
    }
    let cookies;
    try {
      cookies = await readback;
    } catch {
      return indeterminate(
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_COOKIE_READBACK_INDETERMINATE"
      );
    }
    if (!Array.isArray(cookies)) {
      return indeterminate(
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_COOKIE_READBACK_INDETERMINATE"
      );
    }
    if (cookies.length !== 0) {
      return failed(
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_COOKIE_READBACK_NONEMPTY",
        "partial"
      );
    }
    return Object.freeze({
      status: "applied",
      receipt: Object.freeze({
        profileKey: "global-web",
        operationId: lease.operationId,
        clearedStorages: CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES,
        cookieReadbackCount: 0,
        evidence: "electron-clear-storage-data-promise-and-cookie-readback"
      })
    });
  }
}
