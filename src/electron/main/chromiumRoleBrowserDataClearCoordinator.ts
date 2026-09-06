import {
  chromiumPathApi as pathApi,
  chromiumPathKey as ownershipKey,
  canonicalChromiumPath as canonicalPath
} from "./chromiumSessionPath";

import type { RolePathsRecord } from "../../shared/generated";
import {
  CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES,
  type ChromiumBrowserDataStorageType
} from "./chromiumBrowserDataClearStorageTypes";
export { CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES } from
  "./chromiumBrowserDataClearStorageTypes";
import {
  ChromiumRoleBrowserDataClearFreshCoordinator,
  type ChromiumRoleBrowserDataClearFreshLauncherPort
} from "./chromiumRoleBrowserDataClearFreshCoordinator";
import type { ChromiumRoleSessionPort } from "./chromiumRoleSessionRegistry";
type SupportedPlatform = "darwin" | "win32";

export interface ChromiumRoleBrowserDataMaintenanceInput {
  readonly roleId: string;
  readonly operationId: string;
  readonly rolePaths: RolePathsRecord;
}

export interface ChromiumRoleBrowserDataClearInput extends
  ChromiumRoleBrowserDataMaintenanceInput {
  readonly effectId: string;
}

export interface ChromiumRoleBrowserDataMaintenanceLease {
  readonly roleId: string;
  readonly operationId: string;
  readonly chromiumUserDataDir: string;
  readonly session: ChromiumRoleSessionPort;
}

export type ChromiumRoleBrowserDataMaintenanceRejection =
  | "active-surface"
  | "active-migration"
  | "active-import"
  | "active-maintenance"
  | "draining"
  | "path-conflict";

export type ChromiumRoleBrowserDataMaintenanceAcquireResult =
  | Readonly<{
    status: "acquired";
    lease: ChromiumRoleBrowserDataMaintenanceLease;
  }>
  | Readonly<{
    status: "rejected";
    reason: ChromiumRoleBrowserDataMaintenanceRejection;
  }>;

/**
 * Acquisition must be atomic with normal-session and migration acquisition.
 * It rejects live/releasing surfaces, migrations, another maintenance owner,
 * registry drain, and role/path aliases before returning a native Session.
 */
export interface ChromiumRoleBrowserDataMaintenancePort {
  acquire: (
    input: ChromiumRoleBrowserDataMaintenanceInput
  ) => ChromiumRoleBrowserDataMaintenanceAcquireResult;
  release: (lease: ChromiumRoleBrowserDataMaintenanceLease) => Promise<boolean>;
}

export interface ChromiumRoleBrowserDataMaintenanceReservation {
  readonly roleId: string;
  readonly operationId: string;
  readonly effectId: string;
  readonly chromiumUserDataDir: string;
}

export type ChromiumRoleBrowserDataMaintenanceReserveResult =
  | Readonly<{
      status: "acquired";
      reservation: ChromiumRoleBrowserDataMaintenanceReservation;
    }>
  | Readonly<{
      status: "rejected";
      reason: ChromiumRoleBrowserDataMaintenanceRejection;
    }>;

export interface ChromiumRoleBrowserDataMaintenanceReservationPort {
  reserve: (
    input: ChromiumRoleBrowserDataClearInput
  ) => ChromiumRoleBrowserDataMaintenanceReserveResult;
  release: (
    reservation: ChromiumRoleBrowserDataMaintenanceReservation
  ) => Promise<boolean>;
}

export type ChromiumRoleBrowserDataClearResult =
  | Readonly<{
    status: "applied";
    receipt: Readonly<{
      roleId: string;
      operationId: string;
      clearedStorages: readonly ChromiumBrowserDataStorageType[];
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

export interface ChromiumRoleBrowserDataClearCoordinatorInput {
  readonly launcher: ChromiumRoleBrowserDataClearFreshLauncherPort;
  readonly maintenance: ChromiumRoleBrowserDataMaintenanceReservationPort;
  readonly platform: SupportedPlatform;
  readonly retainedSession: ChromiumRoleBrowserDataMaintenancePort;
}

interface ClearLane {
  readonly identityKey: string;
  readonly promise: Promise<ChromiumRoleBrowserDataClearResult>;
}

interface ClearSnapshot {
  readonly input: ChromiumRoleBrowserDataClearInput;
  readonly chromiumPath: string;
  readonly pathKey: string;
}

type ClearPreflight =
  | Readonly<{ ok: true; snapshot: ClearSnapshot }>
  | Readonly<{ ok: false; result: ChromiumRoleBrowserDataClearResult }>;

function failed(
  stableErrorCode: string,
  mutation: "not-started" | "partial" = "not-started"
): ChromiumRoleBrowserDataClearResult {
  return Object.freeze({ status: "failed", stableErrorCode, mutation });
}

function indeterminate(stableErrorCode: string): ChromiumRoleBrowserDataClearResult {
  return Object.freeze({
    status: "indeterminate",
    stableErrorCode,
    mutation: "unknown"
  });
}

function preflight(
  input: ChromiumRoleBrowserDataClearInput,
  platform: SupportedPlatform
): ClearPreflight {
  if (
    typeof input !== "object" ||
    input === null ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      .test(input.roleId) ||
    typeof input.effectId !== "string" ||
    input.effectId.length === 0 ||
    input.effectId.length > 160 ||
    input.effectId !== input.effectId.trim() ||
    [...input.effectId].some((character) => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    }) ||
    typeof input.operationId !== "string" ||
    input.operationId.length === 0 ||
    input.operationId.length > 160 ||
    input.operationId !== input.operationId.trim() ||
    [...input.operationId].some((character) => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    })
  ) {
    return Object.freeze({
      ok: false,
      result: failed("CHROMIUM_ROLE_BROWSER_DATA_CLEAR_IDENTITY_INVALID")
    });
  }
  const browserRoot = canonicalPath(input.rolePaths?.browserUserDataDir, platform);
  const chromiumPath = canonicalPath(
    input.rolePaths?.chromiumUserDataDir,
    platform
  );
  if (!browserRoot || !chromiumPath) {
    return Object.freeze({
      ok: false,
      result: failed("CHROMIUM_ROLE_BROWSER_DATA_CLEAR_PATH_INVALID")
    });
  }
  const paths = pathApi(platform);
  const roleDirectory = paths.dirname(browserRoot);
  if (
    paths.basename(browserRoot) !== "browser" ||
    paths.basename(roleDirectory) !== input.roleId ||
    paths.basename(paths.dirname(roleDirectory)) !== "roles" ||
    paths.join(browserRoot, "chromium") !== chromiumPath
  ) {
    return Object.freeze({
      ok: false,
      result: failed("CHROMIUM_ROLE_BROWSER_DATA_CLEAR_PATH_MISMATCH")
    });
  }
  const rolePaths = Object.freeze({ ...input.rolePaths });
  const snapshot = Object.freeze({
    input: Object.freeze({
      roleId: input.roleId,
      effectId: input.effectId,
      operationId: input.operationId,
      rolePaths
    }),
    chromiumPath,
    pathKey: ownershipKey(chromiumPath, platform)
  });
  return Object.freeze({ ok: true, snapshot });
}

function rejectionCode(
  reason: ChromiumRoleBrowserDataMaintenanceRejection
): string {
  switch (reason) {
    case "active-surface":
      return "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_SESSION_ACTIVE";
    case "active-migration":
      return "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_MIGRATION_ACTIVE";
    case "active-import":
      return "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_IMPORT_ACTIVE";
    case "active-maintenance":
      return "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_OPERATION_CONFLICT";
    case "draining":
      return "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_REGISTRY_DRAINING";
    case "path-conflict":
      return "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_PATH_CONFLICT";
    default:
      return "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_LEASE_ACQUIRE_FAILED";
  }
}

function reservationMatches(
  reservation: ChromiumRoleBrowserDataMaintenanceReservation,
  snapshot: ClearSnapshot,
): boolean {
  return !!reservation && typeof reservation === "object" &&
    reservation.roleId === snapshot.input.roleId &&
    reservation.effectId === snapshot.input.effectId &&
    reservation.operationId === snapshot.input.operationId &&
    reservation.chromiumUserDataDir === snapshot.chromiumPath;
}

function maintenanceLeaseMatches(
  lease: ChromiumRoleBrowserDataMaintenanceLease,
  snapshot: ClearSnapshot
): boolean {
  return !!lease && typeof lease === "object" &&
    lease.roleId === snapshot.input.roleId &&
    lease.operationId === snapshot.input.operationId &&
    lease.chromiumUserDataDir === snapshot.chromiumPath &&
    !!lease.session && typeof lease.session === "object";
}

function promiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Reserves one exact Rust-owned role path while a fixed-mode fresh child clears
 * and drains it. Once that child exits, the main process repeats the clear on
 * Electron's retained Session identity so a previously used role cannot expose
 * stale in-process storage. Both native lanes must terminalize before success.
 */
export class ChromiumRoleBrowserDataClearCoordinator {
  readonly #fresh: ChromiumRoleBrowserDataClearFreshCoordinator;
  readonly #input: ChromiumRoleBrowserDataClearCoordinatorInput;
  readonly #lanesByRole = new Map<string, ClearLane>();

  constructor(input: ChromiumRoleBrowserDataClearCoordinatorInput) {
    this.#input = input;
    this.#fresh = new ChromiumRoleBrowserDataClearFreshCoordinator(
      input.launcher
    );
  }

  clear(
    input: ChromiumRoleBrowserDataClearInput,
    signal?: AbortSignal
  ): Promise<ChromiumRoleBrowserDataClearResult> {
    const checked = preflight(input, this.#input.platform);
    if (!checked.ok) return Promise.resolve(checked.result);
    if (signal?.aborted) {
      return Promise.resolve(failed(
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_CANCELLED"
      ));
    }
    const { snapshot } = checked;
    const identityKey = [
      snapshot.input.roleId,
      snapshot.input.effectId,
      snapshot.input.operationId,
      snapshot.pathKey
    ].join(":");
    const existing = this.#lanesByRole.get(snapshot.input.roleId);
    if (existing) {
      return existing.identityKey === identityKey
        ? existing.promise
        : Promise.resolve(failed(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_OPERATION_CONFLICT"
        ));
    }
    const promise = this.#clear(snapshot, signal).finally(() => {
      if (this.#lanesByRole.get(snapshot.input.roleId)?.promise === promise) {
        this.#lanesByRole.delete(snapshot.input.roleId);
      }
    });
    this.#lanesByRole.set(snapshot.input.roleId, { identityKey, promise });
    return promise;
  }

  async #clear(
    snapshot: ClearSnapshot,
    signal?: AbortSignal
  ): Promise<ChromiumRoleBrowserDataClearResult> {
    let acquisition: ChromiumRoleBrowserDataMaintenanceReserveResult;
    try {
      acquisition = this.#input.maintenance.reserve(snapshot.input);
    } catch {
      return failed("CHROMIUM_ROLE_BROWSER_DATA_CLEAR_LEASE_ACQUIRE_FAILED");
    }
    if (acquisition.status !== "acquired") {
      return failed(rejectionCode(acquisition.reason));
    }
    const { reservation } = acquisition;
    let result: ChromiumRoleBrowserDataClearResult;
    try {
      const fresh = signal?.aborted
        ? Object.freeze({
          status: "failed" as const,
          stableErrorCode: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_CANCELLED"
        })
        : reservationMatches(reservation, snapshot)
        ? await this.#fresh.clearAndVerify(
          snapshot.input,
          this.#input.platform,
          signal
        )
        : null;
      if (fresh === null) {
        result = failed("CHROMIUM_ROLE_BROWSER_DATA_CLEAR_LEASE_INVALID");
      } else if (fresh.status === "failed") {
        result = failed(fresh.stableErrorCode);
      } else if (fresh.status === "indeterminate") {
        result = indeterminate(fresh.stableErrorCode);
      } else result = this.#applied(snapshot);
    } catch {
      result = indeterminate(
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_EXECUTION_INDETERMINATE"
      );
    }
    let releasePromise: Promise<boolean>;
    try {
      releasePromise = this.#input.maintenance.release(reservation);
    } catch {
      return indeterminate(
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RELEASE_INDETERMINATE"
      );
    }
    if (!promiseLike(releasePromise)) {
      return indeterminate(
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RELEASE_INDETERMINATE"
      );
    }
    try {
      if (await releasePromise !== true) {
        return indeterminate(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RELEASE_INDETERMINATE"
        );
      }
    } catch {
      return indeterminate(
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RELEASE_INDETERMINATE"
      );
    }
    if (signal?.aborted && result.status === "applied") {
      return indeterminate("CHROMIUM_ROLE_BROWSER_DATA_CLEAR_CANCELLED");
    }
    return result.status === "applied"
      ? this.#clearRetainedSession(snapshot, signal)
      : result;
  }

  #applied(snapshot: ClearSnapshot): ChromiumRoleBrowserDataClearResult {
    return Object.freeze({
      status: "applied",
      receipt: Object.freeze({
        roleId: snapshot.input.roleId,
        operationId: snapshot.input.operationId,
        clearedStorages: CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES,
        cookieReadbackCount: 0 as const,
        evidence:
          "electron-clear-storage-data-promise-and-cookie-readback" as const
      })
    });
  }

  async #clearRetainedSession(
    snapshot: ClearSnapshot,
    signal?: AbortSignal
  ): Promise<ChromiumRoleBrowserDataClearResult> {
    let acquisition: ChromiumRoleBrowserDataMaintenanceAcquireResult;
    try {
      acquisition = this.#input.retainedSession.acquire({
        roleId: snapshot.input.roleId,
        operationId: snapshot.input.operationId,
        rolePaths: snapshot.input.rolePaths
      });
    } catch {
      return indeterminate(
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RETAINED_SESSION_ACQUIRE_INDETERMINATE"
      );
    }
    if (acquisition.status !== "acquired") {
      return indeterminate(
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RETAINED_SESSION_ACQUIRE_INDETERMINATE"
      );
    }
    const { lease } = acquisition;
    let result: ChromiumRoleBrowserDataClearResult = this.#applied(snapshot);
    try {
      if (signal?.aborted || !maintenanceLeaseMatches(lease, snapshot)) {
        result = indeterminate(signal?.aborted
          ? "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_CANCELLED"
          : "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RETAINED_SESSION_LEASE_INVALID");
      } else {
        const clearing = lease.session.clearStorageData();
        if (!promiseLike(clearing)) {
          result = indeterminate(
            "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RETAINED_SESSION_ACK_UNAVAILABLE"
          );
        } else {
          await clearing;
          const flushing = lease.session.cookies.flushStore();
          if (!promiseLike(flushing)) {
            result = indeterminate(
              "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RETAINED_SESSION_FLUSH_UNAVAILABLE"
            );
          } else {
            await flushing;
            const reading = lease.session.cookies.get({});
            if (!promiseLike(reading)) {
              result = indeterminate(
                "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RETAINED_SESSION_READBACK_UNAVAILABLE"
              );
            } else {
              const cookies = await reading;
              if (!Array.isArray(cookies) || cookies.length !== 0) {
                result = indeterminate(
                  "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RETAINED_SESSION_READBACK_NONEMPTY"
                );
              }
            }
          }
        }
      }
    } catch {
      result = indeterminate(
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RETAINED_SESSION_INDETERMINATE"
      );
    }
    let releasePromise: Promise<boolean>;
    try {
      releasePromise = this.#input.retainedSession.release(lease);
    } catch {
      return indeterminate(
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RETAINED_SESSION_RELEASE_INDETERMINATE"
      );
    }
    if (!promiseLike(releasePromise)) {
      return indeterminate(
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RETAINED_SESSION_RELEASE_INDETERMINATE"
      );
    }
    try {
      if (await releasePromise !== true) {
        return indeterminate(
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RETAINED_SESSION_RELEASE_INDETERMINATE"
        );
      }
    } catch {
      return indeterminate(
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RETAINED_SESSION_RELEASE_INDETERMINATE"
      );
    }
    if (signal?.aborted && result.status === "applied") {
      return indeterminate("CHROMIUM_ROLE_BROWSER_DATA_CLEAR_CANCELLED");
    }
    return result;
  }
}
