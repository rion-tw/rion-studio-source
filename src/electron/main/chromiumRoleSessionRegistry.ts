import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import type { FromPathOptions, Session } from "electron";

import type { RolePathsRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import { installChromiumSessionSecurityPolicy } from
  "./chromiumSecurityPolicy";
import type {
  ChromiumRoleBrowserDataClearInput,
  ChromiumRoleBrowserDataMaintenanceInput,
  ChromiumRoleBrowserDataMaintenanceAcquireResult,
  ChromiumRoleBrowserDataMaintenanceLease,
  ChromiumRoleBrowserDataMaintenanceReservation,
  ChromiumRoleBrowserDataMaintenanceReserveResult
} from "./chromiumRoleBrowserDataClearCoordinator";
import {
  ChromiumSessionOwnershipLedger,
  type ChromiumSessionOwnershipLease
} from "./chromiumSessionOwnershipLedger";

export type ChromiumRoleSessionPort = Pick<
  Session,
  | "cookies"
  | "clearStorageData"
  | "flushStorageData"
  | "on"
  | "protocol"
  | "storagePath"
  | "setBluetoothPairingHandler"
  | "setDevicePermissionHandler"
  | "setDisplayMediaRequestHandler"
  | "setPermissionCheckHandler"
  | "setPermissionRequestHandler"
>;

export interface ChromiumSessionFactoryPort {
  fromPath: (
    path: string,
    options: FromPathOptions
  ) => ChromiumRoleSessionPort;
}

export interface ChromiumRoleSessionHandle {
  readonly roleId: string;
  readonly chromiumUserDataDir: string;
  readonly session: ChromiumRoleSessionPort;
}

export interface AcquireChromiumRoleSessionMigrationInput {
  readonly roleId: string;
  readonly rolePaths: RolePathsRecord;
  readonly transferId: string;
  readonly targetRevision: number;
}

export interface ChromiumRoleSessionMigrationLease extends ChromiumRoleSessionHandle {
  readonly transferId: string;
  readonly targetRevision: number;
}

export interface AcquireChromiumRoleSessionChromeImportInput {
  readonly roleId: string;
  readonly coreLeaseId: string;
  readonly operationId: string;
  readonly transactionId: string;
  readonly journalPhase: ChromeProfileImportJournalPhase;
  readonly journalRevision: number;
  readonly launchOrigin: string;
  readonly replaceExisting: boolean;
  readonly chromiumUserDataDir: string;
  readonly chromiumPathSha256: string;
  readonly stagingSha256: string;
}

export interface ChromiumRoleSessionChromeImportLease extends ChromiumRoleSessionHandle {
  readonly coreLeaseId: string;
  readonly operationId: string;
  readonly transactionId: string;
  readonly journalPhase: ChromeProfileImportJournalPhase;
  readonly journalRevision: number;
  readonly launchOrigin: string;
  readonly replaceExisting: boolean;
  readonly chromiumPathSha256: string;
  readonly stagingSha256: string;
}

export type ChromeProfileImportJournalPhase =
  | "prepared"
  | "snapshotted"
  | "applying"
  | "verified"
  | "metadataCommitted"
  | "awaitingFreshVerification"
  | "freshVerified"
  | "committing";

const CHROME_PROFILE_IMPORT_PHASES = new Set<ChromeProfileImportJournalPhase>([
  "prepared",
  "snapshotted",
  "applying",
  "verified",
  "metadataCommitted",
  "awaitingFreshVerification",
  "freshVerified",
  "committing"
]);

function chromeImportPhaseSet(
  ...phases: ChromeProfileImportJournalPhase[]
): ReadonlySet<ChromeProfileImportJournalPhase> {
  return new Set(phases);
}

const CHROME_PROFILE_IMPORT_PHASE_EDGES: Readonly<
  Partial<Record<ChromeProfileImportJournalPhase, ReadonlySet<ChromeProfileImportJournalPhase>>>
> = Object.freeze({
  prepared: chromeImportPhaseSet("snapshotted"),
  snapshotted: chromeImportPhaseSet("applying"),
  applying: chromeImportPhaseSet("verified"),
  verified: chromeImportPhaseSet("metadataCommitted", "awaitingFreshVerification"),
  awaitingFreshVerification: chromeImportPhaseSet("freshVerified"),
  freshVerified: chromeImportPhaseSet("metadataCommitted"),
  metadataCommitted: chromeImportPhaseSet("committing")
});

interface RoleSessionRecord {
  readonly handle: ChromiumRoleSessionHandle;
  readonly ownershipLease: ChromiumSessionOwnershipLease;
  readonly pathKey: string;
  releasePromise: Promise<boolean> | null;
}

interface RoleSessionMigrationRecord {
  readonly lease: ChromiumRoleSessionMigrationLease;
  readonly pathKey: string;
}

interface RoleSessionMaintenanceRecord {
  readonly lease: ChromiumRoleBrowserDataMaintenanceLease;
  readonly pathKey: string;
}

interface RoleSessionMaintenanceReservationRecord {
  readonly reservation: ChromiumRoleBrowserDataMaintenanceReservation;
  readonly pathKey: string;
}

interface RoleSessionChromeImportRecord {
  lease: ChromiumRoleSessionChromeImportLease;
  readonly pathKey: string;
}

type RegistryState = "open" | "draining" | "disposed";
type SupportedPlatform = "darwin" | "win32";

function registryError(code: string, message: string): never {
  throw new RionBridgeError({ code, message });
}

function validateRoleId(roleId: string): void {
  if (
    typeof roleId !== "string" ||
    roleId.length === 0 ||
    roleId === "." ||
    roleId === ".." ||
    roleId.includes("/") ||
    roleId.includes("\\") ||
    [...roleId].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    registryError(
      "ELECTRON_ROLE_SESSION_ID_INVALID",
      "A non-empty Rust-owned role ID is required for a Chromium session."
    );
  }
}

function validateCanonicalUuid(value: string, fieldName: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  ) {
    registryError(
      "CHROMIUM_SESSION_MIGRATION_IDENTITY_INVALID",
      `A canonical Rust-owned ${fieldName} is required for session migration.`
    );
  }
}

function validateTargetRevision(targetRevision: number): void {
  if (!Number.isSafeInteger(targetRevision) || targetRevision < 1) {
    registryError(
      "CHROMIUM_SESSION_MIGRATION_REVISION_INVALID",
      "A positive Rust-owned target revision is required for session migration."
    );
  }
}

function validateChromeImportInput(
  input: AcquireChromiumRoleSessionChromeImportInput
): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(input.roleId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(input.coreLeaseId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(input.transactionId) ||
    typeof input.operationId !== "string" ||
    input.operationId.length === 0 ||
    input.operationId.length > 300 ||
    input.operationId !== input.operationId.trim() ||
    [...input.operationId].some((character) => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    }) ||
    !CHROME_PROFILE_IMPORT_PHASES.has(input.journalPhase) ||
    !Number.isSafeInteger(input.journalRevision) ||
    input.journalRevision < 1 ||
    typeof input.replaceExisting !== "boolean" ||
    !/^[0-9a-f]{64}$/u.test(input.chromiumPathSha256) ||
    !/^[0-9a-f]{64}$/u.test(input.stagingSha256)
  ) {
    registryError(
      "CHROMIUM_PROFILE_IMPORT_IDENTITY_INVALID",
      "An exact Rust-owned Chrome-import transaction identity is required."
    );
  }
  let origin: URL;
  try {
    origin = new URL(input.launchOrigin);
  } catch {
    registryError(
      "CHROMIUM_PROFILE_IMPORT_IDENTITY_INVALID",
      "An exact Rust-owned Chrome-import launch origin is required."
    );
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== input.launchOrigin ||
    origin.username.length > 0 ||
    origin.password.length > 0 ||
    origin.pathname !== "/" ||
    origin.search.length > 0 ||
    origin.hash.length > 0
  ) {
    registryError(
      "CHROMIUM_PROFILE_IMPORT_IDENTITY_INVALID",
      "An exact Rust-owned Chrome-import launch origin is required."
    );
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pathApi(platform: SupportedPlatform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function canonicalAbsolutePath(
  value: unknown,
  platform: SupportedPlatform,
  fieldName: string
): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    registryError(
      "ELECTRON_ROLE_SESSION_PATH_INVALID",
      `${fieldName} must be a non-empty absolute path supplied by Rust.`
    );
  }
  const paths = pathApi(platform);
  if (!paths.isAbsolute(value) || paths.normalize(value) !== value) {
    registryError(
      "ELECTRON_ROLE_SESSION_PATH_INVALID",
      `${fieldName} must be a canonical absolute path supplied by Rust.`
    );
  }
  return value;
}

function roleChromiumPath(
  roleId: string,
  rolePaths: RolePathsRecord,
  platform: SupportedPlatform
): string {
  const browserRoot = canonicalAbsolutePath(
    rolePaths.browserUserDataDir,
    platform,
    "browserUserDataDir"
  );
  const chromiumPath = canonicalAbsolutePath(
    rolePaths.chromiumUserDataDir,
    platform,
    "chromiumUserDataDir"
  );
  const paths = pathApi(platform);
  const roleDirectory = paths.dirname(browserRoot);
  const rolesDirectory = paths.dirname(roleDirectory);
  const ownsExpectedRoleDirectory =
    paths.basename(browserRoot) === "browser" &&
    paths.basename(roleDirectory) === roleId &&
    paths.basename(rolesDirectory) === "roles";
  if (
    !ownsExpectedRoleDirectory ||
    paths.join(browserRoot, "chromium") !== chromiumPath
  ) {
    registryError(
      "ELECTRON_ROLE_SESSION_PATH_MISMATCH",
      "The Chromium session path is not the Rust-owned browser/chromium directory."
    );
  }
  return chromiumPath;
}

function ownershipKey(path: string, platform: SupportedPlatform): string {
  return platform === "win32" ? path.toLowerCase() : path;
}

function nativeStoragePathKey(
  value: string | null,
  platform: SupportedPlatform
): string {
  const paths = pathApi(platform);
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !paths.isAbsolute(value) ||
    paths.normalize(value) !== value
  ) {
    registryError(
      "CHROMIUM_ROLE_SESSION_NATIVE_PATH_MISMATCH",
      "The native Chromium session did not expose the exact Rust-owned profile path."
    );
  }
  return ownershipKey(value, platform);
}

export class ChromiumRoleSessionRegistry {
  readonly #factory: ChromiumSessionFactoryPort;
  readonly #ownership: ChromiumSessionOwnershipLedger;
  readonly #platform: SupportedPlatform;
  readonly #recordsByRole = new Map<string, RoleSessionRecord>();
  readonly #migrationByRole = new Map<string, RoleSessionMigrationRecord>();
  readonly #maintenanceByRole = new Map<string, RoleSessionMaintenanceRecord>();
  readonly #maintenanceReservationByRole =
    new Map<string, RoleSessionMaintenanceReservationRecord>();
  readonly #chromeImportByRole = new Map<string, RoleSessionChromeImportRecord>();
  readonly #ownedPathByRole = new Map<string, string>();
  readonly #ownerRoleByPath = new Map<string, string>();
  readonly #pathByNativeSession = new WeakMap<object, string>();
  #state: RegistryState = "open";
  #disposePromise: Promise<void> | null = null;

  constructor(
    factory: ChromiumSessionFactoryPort,
    platform: SupportedPlatform,
    ownership = new ChromiumSessionOwnershipLedger(platform)
  ) {
    this.#factory = factory;
    this.#platform = platform;
    this.#ownership = ownership;
  }

  get activeCount(): number {
    return this.#recordsByRole.size;
  }

  get activeMigrationCount(): number {
    return this.#migrationByRole.size;
  }

  get activeMaintenanceCount(): number {
    return this.#maintenanceByRole.size +
      this.#maintenanceReservationByRole.size;
  }

  get activeChromeImportCount(): number {
    return this.#chromeImportByRole.size;
  }

  ensure(roleId: string, rolePaths: RolePathsRecord): ChromiumRoleSessionHandle {
    if (this.#state !== "open") {
      registryError(
        "ELECTRON_ROLE_SESSION_REGISTRY_DRAINING",
        "The Chromium role-session registry is draining and rejects new work."
      );
    }
    validateRoleId(roleId);
    const chromiumPath = roleChromiumPath(roleId, rolePaths, this.#platform);
    const pathKey = ownershipKey(chromiumPath, this.#platform);
    if (
      this.#maintenanceByRole.has(roleId) ||
      this.#maintenanceReservationByRole.has(roleId)
    ) {
      registryError(
        "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_ACTIVE",
        "The role session is exclusively leased to browser-data maintenance."
      );
    }
    if (this.#migrationByRole.has(roleId)) {
      registryError(
        "CHROMIUM_SESSION_MIGRATION_LEASE_ACTIVE",
        "The role session is exclusively leased to a Chromium migration."
      );
    }
    if (this.#chromeImportByRole.has(roleId)) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_LEASE_ACTIVE",
        "The role session is exclusively leased to a Chrome profile import."
      );
    }
    const ownedPath = this.#ownedPathByRole.get(roleId);
    if (ownedPath && ownedPath !== pathKey) {
      registryError(
        "ELECTRON_ROLE_SESSION_OWNERSHIP_CONFLICT",
        "The role is already bound to a different Chromium session path."
      );
    }
    const existing = this.#recordsByRole.get(roleId);
    if (existing) {
      if (existing.pathKey !== pathKey) {
        registryError(
          "ELECTRON_ROLE_SESSION_OWNERSHIP_CONFLICT",
          "The role is already bound to a different Chromium session path."
        );
      }
      if (existing.releasePromise) {
        registryError(
          "ELECTRON_ROLE_SESSION_RELEASING",
          "The Chromium role session is already being released."
        );
      }
      return existing.handle;
    }

    const pathOwner = this.#ownerRoleByPath.get(pathKey);
    if (pathOwner && pathOwner !== roleId) {
      registryError(
        "ELECTRON_ROLE_SESSION_OWNERSHIP_CONFLICT",
        "The Chromium session path is already owned by another role."
      );
    }

    return this.#createRecord(roleId, chromiumPath, pathKey).handle;
  }

  acquireRoleBrowserDataMaintenance(
    input: ChromiumRoleBrowserDataMaintenanceInput
  ): ChromiumRoleBrowserDataMaintenanceAcquireResult {
    if (this.#state !== "open") {
      return Object.freeze({ status: "rejected", reason: "draining" });
    }
    validateRoleId(input.roleId);
    const chromiumPath = roleChromiumPath(
      input.roleId,
      input.rolePaths,
      this.#platform
    );
    const pathKey = ownershipKey(chromiumPath, this.#platform);
    if (this.#maintenanceReservationByRole.has(input.roleId)) {
      return Object.freeze({
        status: "rejected",
        reason: "active-maintenance"
      });
    }
    const existingMaintenance = this.#maintenanceByRole.get(input.roleId);
    if (existingMaintenance) {
      const record = this.#recordsByRole.get(input.roleId);
      if (
        !record?.releasePromise &&
        existingMaintenance.pathKey === pathKey &&
        existingMaintenance.lease.operationId === input.operationId
      ) {
        return Object.freeze({
          status: "acquired",
          lease: existingMaintenance.lease
        });
      }
      return Object.freeze({
        status: "rejected",
        reason: "active-maintenance"
      });
    }
    if (this.#migrationByRole.has(input.roleId)) {
      return Object.freeze({ status: "rejected", reason: "active-migration" });
    }
    if (this.#chromeImportByRole.has(input.roleId)) {
      return Object.freeze({ status: "rejected", reason: "active-import" });
    }
    if (this.#recordsByRole.has(input.roleId)) {
      return Object.freeze({ status: "rejected", reason: "active-surface" });
    }
    const ownedPath = this.#ownedPathByRole.get(input.roleId);
    const pathOwner = this.#ownerRoleByPath.get(pathKey);
    if (
      (ownedPath && ownedPath !== pathKey) ||
      (pathOwner && pathOwner !== input.roleId)
    ) {
      return Object.freeze({ status: "rejected", reason: "path-conflict" });
    }

    const record = this.#createRecord(input.roleId, chromiumPath, pathKey);
    const lease = Object.freeze({
      roleId: input.roleId,
      operationId: input.operationId,
      chromiumUserDataDir: chromiumPath,
      session: record.handle.session
    });
    this.#maintenanceByRole.set(input.roleId, { lease, pathKey });
    return Object.freeze({ status: "acquired", lease });
  }

  releaseRoleBrowserDataMaintenance(
    lease: ChromiumRoleBrowserDataMaintenanceLease
  ): Promise<boolean> {
    validateRoleId(lease.roleId);
    const path = canonicalAbsolutePath(
      lease.chromiumUserDataDir,
      this.#platform,
      "chromiumUserDataDir"
    );
    const maintenance = this.#maintenanceByRole.get(lease.roleId);
    if (
      !maintenance ||
      maintenance.lease !== lease ||
      maintenance.pathKey !== ownershipKey(path, this.#platform)
    ) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_LEASE_STALE",
        message: "The Chromium browser-data maintenance lease is no longer current."
      }));
    }
    const record = this.#recordsByRole.get(lease.roleId);
    if (!record || record.handle.session !== lease.session) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_LEASE_STALE",
        message: "The Chromium browser-data maintenance lease is no longer current."
      }));
    }
    return this.#releaseRecord(lease.roleId, record);
  }

  /**
   * Reserves the exact role path for a fixed-mode child without materializing a
   * Session in this process. This prevents Chromium profile aliasing while the
   * child exclusively reopens and drains the path.
   */
  reserveRoleBrowserDataMaintenance(
    input: ChromiumRoleBrowserDataClearInput
  ): ChromiumRoleBrowserDataMaintenanceReserveResult {
    if (this.#state !== "open") {
      return Object.freeze({ status: "rejected", reason: "draining" });
    }
    validateRoleId(input.roleId);
    const chromiumPath = roleChromiumPath(
      input.roleId,
      input.rolePaths,
      this.#platform
    );
    const pathKey = ownershipKey(chromiumPath, this.#platform);
    const existing = this.#maintenanceReservationByRole.get(input.roleId);
    if (existing) {
      return existing.pathKey === pathKey &&
        existing.reservation.operationId === input.operationId &&
        existing.reservation.effectId === input.effectId
        ? Object.freeze({
          status: "acquired",
          reservation: existing.reservation
        })
        : Object.freeze({
          status: "rejected",
          reason: "active-maintenance"
        });
    }
    if (this.#maintenanceByRole.has(input.roleId)) {
      return Object.freeze({
        status: "rejected",
        reason: "active-maintenance"
      });
    }
    if (this.#migrationByRole.has(input.roleId)) {
      return Object.freeze({ status: "rejected", reason: "active-migration" });
    }
    if (this.#chromeImportByRole.has(input.roleId)) {
      return Object.freeze({ status: "rejected", reason: "active-import" });
    }
    if (this.#recordsByRole.has(input.roleId)) {
      return Object.freeze({ status: "rejected", reason: "active-surface" });
    }
    const ownedPath = this.#ownedPathByRole.get(input.roleId);
    const pathOwner = this.#ownerRoleByPath.get(pathKey);
    if (
      (ownedPath && ownedPath !== pathKey) ||
      (pathOwner && pathOwner !== input.roleId)
    ) {
      return Object.freeze({ status: "rejected", reason: "path-conflict" });
    }
    const reservation = Object.freeze({
      roleId: input.roleId,
      operationId: input.operationId,
      effectId: input.effectId,
      chromiumUserDataDir: chromiumPath
    });
    this.#maintenanceReservationByRole.set(input.roleId, {
      reservation,
      pathKey
    });
    this.#ownedPathByRole.set(input.roleId, pathKey);
    this.#ownerRoleByPath.set(pathKey, input.roleId);
    return Object.freeze({ status: "acquired", reservation });
  }

  releaseRoleBrowserDataMaintenanceReservation(
    reservation: ChromiumRoleBrowserDataMaintenanceReservation
  ): Promise<boolean> {
    validateRoleId(reservation.roleId);
    const path = canonicalAbsolutePath(
      reservation.chromiumUserDataDir,
      this.#platform,
      "chromiumUserDataDir"
    );
    const current = this.#maintenanceReservationByRole.get(
      reservation.roleId
    );
    if (
      !current ||
      current.reservation !== reservation ||
      current.pathKey !== ownershipKey(path, this.#platform)
    ) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_RESERVATION_STALE",
        message: "The fresh browser-data clear reservation is no longer current."
      }));
    }
    this.#maintenanceReservationByRole.delete(reservation.roleId);
    return Promise.resolve(true);
  }

  acquireChromeImportSession(
    input: AcquireChromiumRoleSessionChromeImportInput
  ): ChromiumRoleSessionChromeImportLease {
    if (this.#state !== "open") {
      registryError(
        "ELECTRON_ROLE_SESSION_REGISTRY_DRAINING",
        "The Chromium role-session registry is draining and rejects new work."
      );
    }
    validateRoleId(input.roleId);
    validateChromeImportInput(input);
    const chromiumPath = canonicalAbsolutePath(
      input.chromiumUserDataDir,
      this.#platform,
      "chromiumUserDataDir"
    );
    if (sha256Hex(chromiumPath) !== input.chromiumPathSha256) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_PATH_IDENTITY_MISMATCH",
        "The Chrome-import destination does not match the Core path digest."
      );
    }
    const pathKey = ownershipKey(chromiumPath, this.#platform);
    if (
      this.#maintenanceByRole.has(input.roleId) ||
      this.#maintenanceReservationByRole.has(input.roleId)
    ) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_MAINTENANCE_ACTIVE",
        "Browser-data maintenance owns the Chrome-import destination session."
      );
    }
    if (this.#migrationByRole.has(input.roleId)) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_MIGRATION_ACTIVE",
        "Session migration owns the Chrome-import destination session."
      );
    }
    const existingImport = this.#chromeImportByRole.get(input.roleId);
    if (existingImport) {
      if (this.#recordsByRole.get(input.roleId)?.releasePromise) {
        registryError(
          "CHROMIUM_PROFILE_IMPORT_LEASE_RELEASING",
          "The Chrome-import session lease is completing its native release."
        );
      }
      const { lease } = existingImport;
      if (
        existingImport.pathKey === pathKey &&
        lease.coreLeaseId === input.coreLeaseId &&
        lease.operationId === input.operationId &&
        lease.transactionId === input.transactionId &&
        lease.journalPhase === input.journalPhase &&
        lease.journalRevision === input.journalRevision &&
        lease.launchOrigin === input.launchOrigin &&
        lease.replaceExisting === input.replaceExisting &&
        lease.chromiumPathSha256 === input.chromiumPathSha256 &&
        lease.stagingSha256 === input.stagingSha256
      ) {
        return lease;
      }
      registryError(
        "CHROMIUM_PROFILE_IMPORT_LEASE_CONFLICT",
        "The role session is leased to another Chrome-import identity or revision."
      );
    }
    if ([...this.#chromeImportByRole.entries()].some(([ownerRoleId, active]) =>
      ownerRoleId !== input.roleId && (
        active.lease.coreLeaseId === input.coreLeaseId ||
        active.lease.operationId === input.operationId ||
        active.lease.transactionId === input.transactionId
      )
    )) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_LEASE_CONFLICT",
        "The Chrome-import transaction identity is already leased to another role."
      );
    }
    if (this.#recordsByRole.has(input.roleId)) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_SESSION_ACTIVE",
        "A live Chromium role session cannot be acquired for Chrome profile import."
      );
    }
    const ownedPath = this.#ownedPathByRole.get(input.roleId);
    const pathOwner = this.#ownerRoleByPath.get(pathKey);
    if (
      (ownedPath && ownedPath !== pathKey) ||
      (pathOwner && pathOwner !== input.roleId)
    ) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_PATH_CONFLICT",
        "The Chrome-import destination path is already owned by another identity."
      );
    }
    const record = this.#createRecord(input.roleId, chromiumPath, pathKey);
    const lease = Object.freeze({
      ...record.handle,
      coreLeaseId: input.coreLeaseId,
      operationId: input.operationId,
      transactionId: input.transactionId,
      journalPhase: input.journalPhase,
      journalRevision: input.journalRevision,
      launchOrigin: input.launchOrigin,
      replaceExisting: input.replaceExisting,
      chromiumPathSha256: input.chromiumPathSha256,
      stagingSha256: input.stagingSha256
    });
    this.#chromeImportByRole.set(input.roleId, { lease, pathKey });
    return lease;
  }

  advanceChromeImportSession(
    lease: ChromiumRoleSessionChromeImportLease,
    nextDescriptor: AcquireChromiumRoleSessionChromeImportInput
  ): ChromiumRoleSessionChromeImportLease {
    validateRoleId(lease.roleId);
    validateChromeImportInput(nextDescriptor);
    if (!CHROME_PROFILE_IMPORT_PHASES.has(nextDescriptor.journalPhase)) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_PHASE_INVALID",
        "A known Chrome-import journal phase is required."
      );
    }
    if (
      !Number.isSafeInteger(nextDescriptor.journalRevision) ||
      nextDescriptor.journalRevision !== lease.journalRevision + 1
    ) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_REVISION_INVALID",
        "The Chrome-import journal revision must advance by exactly one."
      );
    }
    if (!CHROME_PROFILE_IMPORT_PHASE_EDGES[lease.journalPhase]
      ?.has(nextDescriptor.journalPhase)) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_PHASE_TRANSITION_INVALID",
        "The Chrome-import journal phase transition is not allowed."
      );
    }
    if (
      nextDescriptor.roleId !== lease.roleId ||
      nextDescriptor.coreLeaseId !== lease.coreLeaseId ||
      nextDescriptor.operationId !== lease.operationId ||
      nextDescriptor.transactionId !== lease.transactionId ||
      nextDescriptor.launchOrigin !== lease.launchOrigin ||
      nextDescriptor.replaceExisting !== lease.replaceExisting ||
      nextDescriptor.chromiumUserDataDir !== lease.chromiumUserDataDir ||
      nextDescriptor.chromiumPathSha256 !== lease.chromiumPathSha256 ||
      nextDescriptor.stagingSha256 !== lease.stagingSha256
    ) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_LEASE_CONFLICT",
        "The next Core descriptor does not match the active Chrome-import lease."
      );
    }
    const current = this.#chromeImportByRole.get(lease.roleId);
    const record = this.#recordsByRole.get(lease.roleId);
    if (
      !current ||
      current.lease !== lease ||
      !record ||
      record.releasePromise ||
      record.handle.session !== lease.session ||
      current.pathKey !== ownershipKey(lease.chromiumUserDataDir, this.#platform)
    ) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_LEASE_STALE",
        "The Chrome-import session lease is no longer current."
      );
    }
    const nextLease = Object.freeze({
      ...lease,
      journalPhase: nextDescriptor.journalPhase,
      journalRevision: nextDescriptor.journalRevision
    });
    current.lease = nextLease;
    return nextLease;
  }

  releaseChromeImportSession(
    lease: ChromiumRoleSessionChromeImportLease
  ): Promise<boolean> {
    validateRoleId(lease.roleId);
    const path = canonicalAbsolutePath(
      lease.chromiumUserDataDir,
      this.#platform,
      "chromiumUserDataDir"
    );
    const current = this.#chromeImportByRole.get(lease.roleId);
    if (
      !current ||
      current.lease !== lease ||
      current.pathKey !== ownershipKey(path, this.#platform)
    ) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_PROFILE_IMPORT_LEASE_STALE",
        message: "The Chrome-import session lease is no longer current."
      }));
    }
    const record = this.#recordsByRole.get(lease.roleId);
    if (!record || record.handle.session !== lease.session) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_PROFILE_IMPORT_LEASE_STALE",
        message: "The Chrome-import session lease is no longer current."
      }));
    }
    return this.#releaseRecord(lease.roleId, record);
  }

  acquireMigrationSession(
    input: AcquireChromiumRoleSessionMigrationInput
  ): ChromiumRoleSessionMigrationLease {
    if (this.#state !== "open") {
      registryError(
        "ELECTRON_ROLE_SESSION_REGISTRY_DRAINING",
        "The Chromium role-session registry is draining and rejects new work."
      );
    }
    validateRoleId(input.roleId);
    validateCanonicalUuid(input.roleId, "role ID");
    validateCanonicalUuid(input.transferId, "transfer ID");
    validateTargetRevision(input.targetRevision);
    const chromiumPath = roleChromiumPath(
      input.roleId,
      input.rolePaths,
      this.#platform
    );
    const pathKey = ownershipKey(chromiumPath, this.#platform);
    if (
      this.#maintenanceByRole.has(input.roleId) ||
      this.#maintenanceReservationByRole.has(input.roleId)
    ) {
      registryError(
        "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_ACTIVE",
        "The role session is exclusively leased to browser-data maintenance."
      );
    }
    if (this.#chromeImportByRole.has(input.roleId)) {
      registryError(
        "CHROMIUM_PROFILE_IMPORT_LEASE_ACTIVE",
        "The role session is exclusively leased to a Chrome profile import."
      );
    }
    const existingMigration = this.#migrationByRole.get(input.roleId);
    if (existingMigration) {
      if (this.#recordsByRole.get(input.roleId)?.releasePromise) {
        registryError(
          "CHROMIUM_SESSION_MIGRATION_LEASE_RELEASING",
          "The Chromium migration lease is completing its native release."
        );
      }
      if (
        existingMigration.pathKey === pathKey &&
        existingMigration.lease.transferId === input.transferId &&
        existingMigration.lease.targetRevision === input.targetRevision
      ) {
        return existingMigration.lease;
      }
      registryError(
        "CHROMIUM_SESSION_MIGRATION_LEASE_CONFLICT",
        "The role session is leased to another migration identity or revision."
      );
    }
    if (this.#recordsByRole.has(input.roleId)) {
      registryError(
        "CHROMIUM_SESSION_MIGRATION_SESSION_ACTIVE",
        "A live Chromium role session cannot be acquired for migration."
      );
    }
    const pathOwner = this.#ownerRoleByPath.get(pathKey);
    if (pathOwner && pathOwner !== input.roleId) {
      registryError(
        "ELECTRON_ROLE_SESSION_OWNERSHIP_CONFLICT",
        "The Chromium session path is already owned by another role."
      );
    }
    const record = this.#createRecord(input.roleId, chromiumPath, pathKey);
    const lease = Object.freeze({
      ...record.handle,
      transferId: input.transferId,
      targetRevision: input.targetRevision
    });
    this.#migrationByRole.set(input.roleId, { lease, pathKey });
    return lease;
  }

  releaseMigrationSession(
    lease: ChromiumRoleSessionMigrationLease
  ): Promise<boolean> {
    validateRoleId(lease.roleId);
    validateCanonicalUuid(lease.roleId, "role ID");
    validateCanonicalUuid(lease.transferId, "transfer ID");
    validateTargetRevision(lease.targetRevision);
    const path = canonicalAbsolutePath(
      lease.chromiumUserDataDir,
      this.#platform,
      "chromiumUserDataDir"
    );
    const migration = this.#migrationByRole.get(lease.roleId);
    if (
      !migration ||
      migration.lease !== lease ||
      migration.pathKey !== ownershipKey(path, this.#platform)
    ) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_SESSION_MIGRATION_LEASE_STALE",
        message: "The Chromium session migration lease is no longer current."
      }));
    }
    const record = this.#recordsByRole.get(lease.roleId);
    if (!record || record.handle.session !== lease.session) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_SESSION_MIGRATION_LEASE_STALE",
        message: "The Chromium session migration lease is no longer current."
      }));
    }
    return this.#releaseRecord(lease.roleId, record);
  }

  releaseRole(roleId: string, chromiumUserDataDir: string): Promise<boolean> {
    validateRoleId(roleId);
    const path = canonicalAbsolutePath(
      chromiumUserDataDir,
      this.#platform,
      "chromiumUserDataDir"
    );
    const pathKey = ownershipKey(path, this.#platform);
    if (
      this.#maintenanceByRole.has(roleId) ||
      this.#maintenanceReservationByRole.has(roleId)
    ) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_ACTIVE",
        message: "The role session is exclusively leased to browser-data maintenance."
      }));
    }
    if (this.#migrationByRole.has(roleId)) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_SESSION_MIGRATION_LEASE_ACTIVE",
        message: "The role session is exclusively leased to a Chromium migration."
      }));
    }
    if (this.#chromeImportByRole.has(roleId)) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_PROFILE_IMPORT_LEASE_ACTIVE",
        message: "The role session is exclusively leased to a Chrome profile import."
      }));
    }
    const record = this.#recordsByRole.get(roleId);
    if (!record) {
      const ownedPath = this.#ownedPathByRole.get(roleId);
      const owner = this.#ownerRoleByPath.get(pathKey);
      if (ownedPath && ownedPath !== pathKey) {
        return Promise.reject(new RionBridgeError({
          code: "ELECTRON_ROLE_SESSION_OWNERSHIP_CONFLICT",
          message: "The role is bound to a different Chromium session path."
        }));
      }
      if (owner && owner !== roleId) {
        return Promise.reject(new RionBridgeError({
          code: "ELECTRON_ROLE_SESSION_OWNERSHIP_CONFLICT",
          message: "The Chromium session path is owned by another role."
        }));
      }
      return Promise.resolve(false);
    }
    if (record.pathKey !== pathKey) {
      return Promise.reject(new RionBridgeError({
        code: "ELECTRON_ROLE_SESSION_OWNERSHIP_CONFLICT",
        message: "The role is bound to a different Chromium session path."
      }));
    }
    return this.#releaseRecord(roleId, record);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    if (this.#migrationByRole.size > 0) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_SESSION_MIGRATION_LEASE_ACTIVE",
        message: "An active Chromium migration lease must terminalize before drain."
      }));
    }
    if (
      this.#maintenanceByRole.size > 0 ||
      this.#maintenanceReservationByRole.size > 0
    ) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_ACTIVE",
        message: "Browser-data maintenance must terminalize before registry drain."
      }));
    }
    if (this.#chromeImportByRole.size > 0) {
      return Promise.reject(new RionBridgeError({
        code: "CHROMIUM_PROFILE_IMPORT_LEASE_ACTIVE",
        message: "Chrome profile import must terminalize before registry drain."
      }));
    }
    this.#state = "draining";
    const releases = [...this.#recordsByRole.entries()].map(([roleId, record]) =>
      this.#releaseRecord(roleId, record)
    );
    this.#disposePromise = Promise.allSettled(releases)
      .then((results) => {
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected"
        );
        if (failure) throw failure.reason;
        this.#state = "disposed";
      })
      .catch((error: unknown) => {
        this.#disposePromise = null;
        throw error;
      });
    return this.#disposePromise;
  }

  #releaseRecord(roleId: string, record: RoleSessionRecord): Promise<boolean> {
    if (record.releasePromise) return record.releasePromise;
    let cookieFlush: Promise<void>;
    try {
      record.handle.session.flushStorageData();
      cookieFlush = record.handle.session.cookies.flushStore();
    } catch (error) {
      return Promise.reject(error);
    }
    // EventBound: ownership ends only after Chromium confirms its cookie-store flush.
    record.releasePromise = cookieFlush
      .then(() => {
        if (!this.#ownership.release(record.ownershipLease)) {
          registryError(
            "ELECTRON_ROLE_SESSION_OWNERSHIP_LEASE_STALE",
            "The role session lost its process-wide native ownership lease."
          );
        }
        if (this.#recordsByRole.get(roleId) === record) {
          this.#recordsByRole.delete(roleId);
        }
        if (this.#migrationByRole.get(roleId)?.lease.session === record.handle.session) {
          this.#migrationByRole.delete(roleId);
        }
        if (this.#maintenanceByRole.get(roleId)?.lease.session === record.handle.session) {
          this.#maintenanceByRole.delete(roleId);
        }
        if (this.#chromeImportByRole.get(roleId)?.lease.session === record.handle.session) {
          this.#chromeImportByRole.delete(roleId);
        }
        return true;
      })
      .catch((error: unknown) => {
        record.releasePromise = null;
        throw error;
      });
    return record.releasePromise;
  }

  #createRecord(
    roleId: string,
    chromiumPath: string,
    pathKey: string
  ): RoleSessionRecord {
    const session = this.#factory.fromPath(chromiumPath, { cache: true });
    const nativePath = this.#pathByNativeSession.get(session);
    if (nativePath && nativePath !== pathKey) {
      registryError(
        "ELECTRON_ROLE_SESSION_NATIVE_ALIAS",
        "Electron returned one native session for distinct Chromium profile paths."
      );
    }
    if (nativeStoragePathKey(session.storagePath, this.#platform) !== pathKey) {
      registryError(
        "CHROMIUM_ROLE_SESSION_NATIVE_PATH_MISMATCH",
        "The native Chromium session did not expose the exact Rust-owned profile path."
      );
    }
    this.#pathByNativeSession.set(session, pathKey);
    const ownershipLease = this.#ownership.claim(
      `role:${roleId}`,
      chromiumPath,
      session
    );
    installChromiumSessionSecurityPolicy(session);

    const handle = Object.freeze({
      roleId,
      chromiumUserDataDir: chromiumPath,
      session
    });
    const record: RoleSessionRecord = {
      handle,
      ownershipLease,
      pathKey,
      releasePromise: null
    };
    this.#recordsByRole.set(roleId, record);
    this.#ownedPathByRole.set(roleId, pathKey);
    this.#ownerRoleByPath.set(pathKey, roleId);
    return record;
  }
}
