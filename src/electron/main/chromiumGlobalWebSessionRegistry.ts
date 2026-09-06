import {
  chromiumPathApi as pathApi,
  chromiumPathKey as ownershipKey,
  chromiumPathSegmentEquals as fixedSegmentEquals,
  canonicalChromiumPath
} from "./chromiumSessionPath";

import type { GlobalWebProfilePathsRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import { installChromiumSessionSecurityPolicy } from
  "./chromiumSecurityPolicy";
import type {
  ChromiumRoleSessionPort,
  ChromiumSessionFactoryPort
} from "./chromiumRoleSessionRegistry";
import {
  ChromiumSessionOwnershipLedger,
  type ChromiumSessionOwnershipLease
} from "./chromiumSessionOwnershipLedger";

type RegistryState = "open" | "draining" | "disposed";
type SupportedPlatform = "darwin" | "win32";

const GLOBAL_WEB_PROFILE_KEY = "global-web";
const MAX_GLOBAL_WEB_SURFACES = 512;

export type ChromiumGlobalWebProfilePaths = GlobalWebProfilePathsRecord;

export interface ChromiumGlobalWebSessionHandle {
  readonly profileKey: "global-web";
  readonly chromiumUserDataDir: string;
  readonly session: ChromiumRoleSessionPort;
}

export interface ChromiumGlobalWebSurfaceLease
extends ChromiumGlobalWebSessionHandle {
  readonly surfaceId: string;
  readonly surfaceGeneration: number;
}

export interface ChromiumGlobalWebMaintenanceLease
extends ChromiumGlobalWebSessionHandle {
  readonly operationId: string;
}

export type ChromiumGlobalWebMaintenanceAcquireResult =
  | Readonly<{
      status: "acquired";
      lease: ChromiumGlobalWebMaintenanceLease;
    }>
  | Readonly<{
      status: "rejected";
      reason: "active-maintenance" | "active-surface" | "draining" |
        "path-conflict" | "releasing";
    }>;

interface GlobalWebSessionRecord {
  readonly handle: ChromiumGlobalWebSessionHandle;
  readonly ownershipLease: ChromiumSessionOwnershipLease;
  readonly pathKey: string;
  readonly surfaces: Map<string, ChromiumGlobalWebSurfaceLease>;
  releasePromise: Promise<boolean> | null;
}

function registryError(code: string, message: string): never {
  throw new RionBridgeError({ code, message });
}

function canonicalAbsolutePath(
  value: unknown,
  platform: SupportedPlatform
): string {
  const path = canonicalChromiumPath(value, platform);
  if (path === null) {
    registryError(
      "ELECTRON_GLOBAL_WEB_SESSION_PATH_INVALID",
      "The global Web Chromium profile must be a canonical absolute Rust-owned path."
    );
  }
  return path;
}

function globalWebChromiumPath(
  profile: ChromiumGlobalWebProfilePaths,
  platform: SupportedPlatform
): string {
  if (!profile || profile.profileKey !== GLOBAL_WEB_PROFILE_KEY) {
    registryError(
      "ELECTRON_GLOBAL_WEB_SESSION_PROFILE_INVALID",
      "The global Web session requires the exact Rust-owned global-web profile key."
    );
  }
  const chromiumPath = canonicalAbsolutePath(
    profile.chromiumUserDataDir,
    platform
  );
  const paths = pathApi(platform);
  const profileDirectory = paths.dirname(chromiumPath);
  const profilesDirectory = paths.dirname(profileDirectory);
  if (
    !fixedSegmentEquals(paths.basename(chromiumPath), "chromium", platform) ||
    !fixedSegmentEquals(paths.basename(profileDirectory), "global-web", platform) ||
    !fixedSegmentEquals(paths.basename(profilesDirectory), "web-profiles", platform)
  ) {
    registryError(
      "ELECTRON_GLOBAL_WEB_SESSION_PATH_MISMATCH",
      "The global Web session path is not web-profiles/global-web/chromium."
    );
  }
  return chromiumPath;
}

function validateIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 256 ||
    value !== value.trim() || value.includes("/") || value.includes("\\") ||
    [...value].some((character) => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    })
  ) {
    registryError(
      "ELECTRON_GLOBAL_WEB_SESSION_ID_INVALID",
      `The global Web ${field} identity is invalid.`
    );
  }
}

function validateGeneration(generation: unknown): asserts generation is number {
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    registryError(
      "ELECTRON_GLOBAL_WEB_SESSION_GENERATION_INVALID",
      "The global Web surface generation must be a positive safe integer."
    );
  }
}

/**
 * Owns the one persistent Chromium session shared only by workspace Web
 * surfaces. Managed roles use ChromiumRoleSessionRegistry and can never enter
 * this ref-counted profile. Ownership ends only after Chromium's exact storage
 * and cookie-store flush acknowledgements.
 */
export class ChromiumGlobalWebSessionRegistry {
  readonly #factory: ChromiumSessionFactoryPort;
  readonly #ownership: ChromiumSessionOwnershipLedger;
  readonly #platform: SupportedPlatform;
  readonly #nativePath = new WeakMap<object, string>();
  readonly #retiredSurfaceLeases = new WeakSet<object>();
  #boundPathKey: string | null = null;
  #record: GlobalWebSessionRecord | null = null;
  #maintenance: ChromiumGlobalWebMaintenanceLease | null = null;
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

  get activeSurfaceCount(): number {
    return this.#record?.surfaces.size ?? 0;
  }

  get maintenanceActive(): boolean {
    return this.#maintenance !== null;
  }

  acquireSurface(
    surfaceId: string,
    surfaceGeneration: number,
    profile: ChromiumGlobalWebProfilePaths
  ): ChromiumGlobalWebSurfaceLease {
    this.#requireOpen();
    validateIdentifier(surfaceId, "surface");
    validateGeneration(surfaceGeneration);
    if (this.#maintenance) {
      registryError(
        "ELECTRON_GLOBAL_WEB_SESSION_MAINTENANCE_ACTIVE",
        "The global Web profile is exclusively leased to browser-data maintenance."
      );
    }
    const record = this.#ensureRecord(profile);
    if (record.releasePromise) {
      registryError(
        "ELECTRON_GLOBAL_WEB_SESSION_RELEASING",
        "The global Web session is awaiting its exact native storage flush."
      );
    }
    const existing = record.surfaces.get(surfaceId);
    if (existing) {
      if (existing.surfaceGeneration === surfaceGeneration) return existing;
      registryError(
        "ELECTRON_GLOBAL_WEB_SESSION_SURFACE_CONFLICT",
        "The global Web surface is still owned by another native generation."
      );
    }
    if (record.surfaces.size >= MAX_GLOBAL_WEB_SURFACES) {
      registryError(
        "ELECTRON_GLOBAL_WEB_SESSION_CAPACITY",
        "The bounded global Web surface-session registry is full."
      );
    }
    const lease = Object.freeze({
      ...record.handle,
      surfaceId,
      surfaceGeneration
    });
    record.surfaces.set(surfaceId, lease);
    return lease;
  }

  releaseSurface(lease: ChromiumGlobalWebSurfaceLease): Promise<boolean> {
    this.#validateSurfaceLeaseShape(lease);
    if (this.#retiredSurfaceLeases.has(lease)) return Promise.resolve(false);
    const record = this.#record;
    if (!record || record.surfaces.get(lease.surfaceId) !== lease ||
      record.handle.session !== lease.session) {
      return Promise.reject(new RionBridgeError({
        code: "ELECTRON_GLOBAL_WEB_SESSION_LEASE_STALE",
        message: "The global Web surface-session lease is no longer current."
      }));
    }
    if (record.releasePromise) return record.releasePromise;
    if (record.surfaces.size > 1) {
      record.surfaces.delete(lease.surfaceId);
      this.#retiredSurfaceLeases.add(lease);
      return Promise.resolve(false);
    }
    return this.#releaseLastSurface(record, lease);
  }

  acquireMaintenance(
    operationId: string,
    profile: ChromiumGlobalWebProfilePaths
  ): ChromiumGlobalWebMaintenanceAcquireResult {
    if (this.#state !== "open") {
      return Object.freeze({ status: "rejected", reason: "draining" });
    }
    validateIdentifier(operationId, "maintenance operation");
    let chromiumPath: string;
    try {
      chromiumPath = globalWebChromiumPath(profile, this.#platform);
    } catch {
      return Object.freeze({ status: "rejected", reason: "path-conflict" });
    }
    const pathKey = ownershipKey(chromiumPath, this.#platform);
    if (this.#boundPathKey && this.#boundPathKey !== pathKey) {
      return Object.freeze({ status: "rejected", reason: "path-conflict" });
    }
    if (this.#maintenance) {
      return this.#maintenance.operationId === operationId &&
        ownershipKey(this.#maintenance.chromiumUserDataDir, this.#platform) === pathKey
        ? Object.freeze({ status: "acquired", lease: this.#maintenance })
        : Object.freeze({ status: "rejected", reason: "active-maintenance" });
    }
    if (this.#record?.releasePromise) {
      return Object.freeze({ status: "rejected", reason: "releasing" });
    }
    if ((this.#record?.surfaces.size ?? 0) > 0) {
      return Object.freeze({ status: "rejected", reason: "active-surface" });
    }
    const record = this.#record ?? this.#createRecord(chromiumPath, pathKey);
    const lease = Object.freeze({ ...record.handle, operationId });
    this.#maintenance = lease;
    return Object.freeze({ status: "acquired", lease });
  }

  releaseMaintenance(lease: ChromiumGlobalWebMaintenanceLease): Promise<boolean> {
    validateIdentifier(lease.operationId, "maintenance operation");
    const record = this.#record;
    if (!record || this.#maintenance !== lease ||
      record.handle.session !== lease.session || record.surfaces.size !== 0) {
      return Promise.reject(new RionBridgeError({
        code: "ELECTRON_GLOBAL_WEB_SESSION_MAINTENANCE_LEASE_STALE",
        message: "The global Web maintenance lease is no longer current."
      }));
    }
    if (record.releasePromise) return record.releasePromise;
    record.releasePromise = this.#flush(record).then(() => {
      this.#releaseOwnership(record);
      if (this.#record === record) this.#record = null;
      if (this.#maintenance === lease) this.#maintenance = null;
      return true;
    }).catch((error: unknown) => {
      record.releasePromise = null;
      throw error;
    });
    return record.releasePromise;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    if (this.#maintenance) {
      return Promise.reject(new RionBridgeError({
        code: "ELECTRON_GLOBAL_WEB_SESSION_MAINTENANCE_ACTIVE",
        message: "Global Web maintenance must terminalize before registry drain."
      }));
    }
    this.#state = "draining";
    const record = this.#record;
    if (!record) {
      this.#state = "disposed";
      return Promise.resolve();
    }
    const leases = [...record.surfaces.values()];
    for (const lease of leases.slice(0, -1)) {
      record.surfaces.delete(lease.surfaceId);
      this.#retiredSurfaceLeases.add(lease);
    }
    const release = leases.length > 0
      ? this.releaseSurface(leases.at(-1)!)
      : this.#flushEmptyRecord(record);
    this.#disposePromise = release.then(() => {
      this.#state = "disposed";
    }).catch((error: unknown) => {
      this.#disposePromise = null;
      throw error;
    });
    return this.#disposePromise;
  }

  #requireOpen(): void {
    if (this.#state !== "open") {
      registryError(
        "ELECTRON_GLOBAL_WEB_SESSION_REGISTRY_DRAINING",
        "The global Web session registry is draining and rejects new work."
      );
    }
  }

  #ensureRecord(profile: ChromiumGlobalWebProfilePaths): GlobalWebSessionRecord {
    const chromiumPath = globalWebChromiumPath(profile, this.#platform);
    const pathKey = ownershipKey(chromiumPath, this.#platform);
    if (this.#boundPathKey && this.#boundPathKey !== pathKey) {
      registryError(
        "ELECTRON_GLOBAL_WEB_SESSION_PATH_CONFLICT",
        "The global Web profile is already bound to another Rust-owned path."
      );
    }
    return this.#record ?? this.#createRecord(chromiumPath, pathKey);
  }

  #createRecord(chromiumPath: string, pathKey: string): GlobalWebSessionRecord {
    const session = this.#factory.fromPath(chromiumPath, { cache: true });
    const knownNativePath = this.#nativePath.get(session);
    if (knownNativePath && knownNativePath !== pathKey) {
      registryError(
        "ELECTRON_GLOBAL_WEB_SESSION_NATIVE_ALIAS",
        "Electron returned one native session for distinct global Web profile paths."
      );
    }
    if (ownershipKey(canonicalAbsolutePath(
      session.storagePath,
      this.#platform
    ), this.#platform) !== pathKey) {
      registryError(
        "ELECTRON_GLOBAL_WEB_SESSION_NATIVE_PATH_MISMATCH",
        "The native Chromium session did not expose the exact global Web profile path."
      );
    }
    this.#nativePath.set(session, pathKey);
    this.#boundPathKey = pathKey;
    const ownershipLease = this.#ownership.claim(
      GLOBAL_WEB_PROFILE_KEY,
      chromiumPath,
      session
    );
    installChromiumSessionSecurityPolicy(session, {
      allowMainFrameHtmlFullscreen: true
    });
    const handle = Object.freeze({
      profileKey: GLOBAL_WEB_PROFILE_KEY,
      chromiumUserDataDir: chromiumPath,
      session
    }) as ChromiumGlobalWebSessionHandle;
    const record: GlobalWebSessionRecord = {
      handle,
      ownershipLease,
      pathKey,
      surfaces: new Map(),
      releasePromise: null
    };
    this.#record = record;
    return record;
  }

  #releaseLastSurface(
    record: GlobalWebSessionRecord,
    lease: ChromiumGlobalWebSurfaceLease
  ): Promise<boolean> {
    record.releasePromise = this.#flush(record).then(() => {
      this.#releaseOwnership(record);
      record.surfaces.delete(lease.surfaceId);
      this.#retiredSurfaceLeases.add(lease);
      if (this.#record === record) this.#record = null;
      return true;
    }).catch((error: unknown) => {
      record.releasePromise = null;
      throw error;
    });
    return record.releasePromise;
  }

  #flushEmptyRecord(record: GlobalWebSessionRecord): Promise<boolean> {
    record.releasePromise = this.#flush(record).then(() => {
      this.#releaseOwnership(record);
      if (this.#record === record) this.#record = null;
      return true;
    }).catch((error: unknown) => {
      record.releasePromise = null;
      throw error;
    });
    return record.releasePromise;
  }

  #flush(record: GlobalWebSessionRecord): Promise<void> {
    try {
      record.handle.session.flushStorageData();
      // EventBound: the exact native cookie-store acknowledgement releases
      // shared profile ownership; elapsed time never implies completion.
      return record.handle.session.cookies.flushStore();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #releaseOwnership(record: GlobalWebSessionRecord): void {
    if (!this.#ownership.release(record.ownershipLease)) {
      registryError(
        "ELECTRON_GLOBAL_WEB_SESSION_OWNERSHIP_LEASE_STALE",
        "The global Web session lost its process-wide native ownership lease."
      );
    }
  }

  #validateSurfaceLeaseShape(lease: ChromiumGlobalWebSurfaceLease): void {
    validateIdentifier(lease.surfaceId, "surface");
    validateGeneration(lease.surfaceGeneration);
    if (lease.profileKey !== GLOBAL_WEB_PROFILE_KEY) {
      registryError(
        "ELECTRON_GLOBAL_WEB_SESSION_LEASE_STALE",
        "The global Web surface-session lease has an invalid profile identity."
      );
    }
    canonicalAbsolutePath(lease.chromiumUserDataDir, this.#platform);
  }
}
