import {
  chromiumPathKey as pathKey,
  canonicalChromiumPath
} from "./chromiumSessionPath";

import { RionBridgeError } from "../ipc/errors";

type SupportedPlatform = "darwin" | "win32";

const MAX_SESSION_OWNERS = 1024;

export interface ChromiumSessionOwnershipLease {
  readonly ownerId: string;
  readonly path: string;
  readonly session: object;
}

interface ActiveClaim {
  readonly lease: ChromiumSessionOwnershipLease;
  readonly pathKey: string;
}

function ownershipError(code: string, message: string): never {
  throw new RionBridgeError({ code, message });
}

function validateOwnerId(ownerId: unknown): asserts ownerId is string {
  if (
    typeof ownerId !== "string" || ownerId.length === 0 || ownerId.length > 300 ||
    ownerId !== ownerId.trim() ||
    [...ownerId].some((character) => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    })
  ) {
    ownershipError(
      "ELECTRON_CHROMIUM_SESSION_OWNER_INVALID",
      "A bounded exact Chromium session owner identity is required."
    );
  }
}

function validatePath(path: unknown, platform: SupportedPlatform): string {
  const canonical = canonicalChromiumPath(path, platform);
  if (canonical === null) {
    ownershipError(
      "ELECTRON_CHROMIUM_SESSION_OWNERSHIP_PATH_INVALID",
      "A canonical absolute Rust-owned Chromium session path is required."
    );
  }
  return canonical;
}

/**
 * Process-local cross-registry fence for Electron Session identity.
 *
 * Path-to-security-domain and native Session-to-path bindings remain for the
 * process lifetime. Active claims end only after their registry observes the
 * exact Chromium storage flush, so role, migration, maintenance, and global
 * Web registries cannot accidentally alias one native session.
 */
export class ChromiumSessionOwnershipLedger {
  readonly #platform: SupportedPlatform;
  readonly #activeByOwner = new Map<string, ActiveClaim>();
  readonly #activeOwnerByNative = new WeakMap<object, string>();
  readonly #boundOwnerByPath = new Map<string, string>();
  readonly #boundPathByNative = new WeakMap<object, string>();

  constructor(platform: SupportedPlatform) {
    this.#platform = platform;
  }

  get activeCount(): number {
    return this.#activeByOwner.size;
  }

  claim(ownerId: string, path: string, session: object): ChromiumSessionOwnershipLease {
    validateOwnerId(ownerId);
    const canonicalPath = validatePath(path, this.#platform);
    if (!session || typeof session !== "object") {
      ownershipError(
        "ELECTRON_CHROMIUM_SESSION_NATIVE_INVALID",
        "Electron returned an invalid native Chromium session."
      );
    }
    const canonicalPathKey = pathKey(canonicalPath, this.#platform);
    const existing = this.#activeByOwner.get(ownerId);
    if (existing) {
      if (existing.pathKey === canonicalPathKey && existing.lease.session === session) {
        return existing.lease;
      }
      ownershipError(
        "ELECTRON_CHROMIUM_SESSION_OWNER_CONFLICT",
        "The Chromium security-domain owner already has another active native session."
      );
    }
    if (this.#activeByOwner.size >= MAX_SESSION_OWNERS) {
      ownershipError(
        "ELECTRON_CHROMIUM_SESSION_OWNERSHIP_CAPACITY",
        "The bounded Chromium session ownership ledger is full."
      );
    }
    const boundOwner = this.#boundOwnerByPath.get(canonicalPathKey);
    if (boundOwner && boundOwner !== ownerId) {
      ownershipError(
        "ELECTRON_CHROMIUM_SESSION_PATH_OWNER_CONFLICT",
        "The Chromium profile path is permanently bound to another security domain."
      );
    }
    const boundNativePath = this.#boundPathByNative.get(session);
    if (boundNativePath && boundNativePath !== canonicalPathKey) {
      ownershipError(
        "ELECTRON_CHROMIUM_SESSION_NATIVE_ALIAS",
        "Electron returned one native session for distinct Chromium profile paths."
      );
    }
    const activeNativeOwner = this.#activeOwnerByNative.get(session);
    if (activeNativeOwner && activeNativeOwner !== ownerId) {
      ownershipError(
        "ELECTRON_CHROMIUM_SESSION_NATIVE_OWNER_CONFLICT",
        "The native Chromium session is already active in another security domain."
      );
    }

    const lease = Object.freeze({ ownerId, path: canonicalPath, session });
    this.#boundOwnerByPath.set(canonicalPathKey, ownerId);
    this.#boundPathByNative.set(session, canonicalPathKey);
    this.#activeOwnerByNative.set(session, ownerId);
    this.#activeByOwner.set(ownerId, { lease, pathKey: canonicalPathKey });
    return lease;
  }

  release(lease: ChromiumSessionOwnershipLease): boolean {
    validateOwnerId(lease.ownerId);
    const canonicalPath = validatePath(lease.path, this.#platform);
    const claim = this.#activeByOwner.get(lease.ownerId);
    if (!claim) return false;
    if (
      claim.lease !== lease || claim.lease.session !== lease.session ||
      claim.pathKey !== pathKey(canonicalPath, this.#platform) ||
      this.#activeOwnerByNative.get(lease.session) !== lease.ownerId
    ) {
      ownershipError(
        "ELECTRON_CHROMIUM_SESSION_OWNERSHIP_LEASE_STALE",
        "The Chromium session ownership lease is no longer current."
      );
    }
    this.#activeByOwner.delete(lease.ownerId);
    this.#activeOwnerByNative.delete(lease.session);
    return true;
  }
}
