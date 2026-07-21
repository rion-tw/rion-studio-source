import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SessionStorageByOrigin = Record<string, Record<string, string>>;

export type EncodedStorageValue =
  | null
  | boolean
  | number
  | string
  | {
      type: "undefined" | "number" | "bigint" | "date" | "array-buffer" | "blob" | "typed-array";
      value?: string;
      name?: string;
      mimeType?: string;
    }
  | { type: "array"; values: EncodedStorageValue[] }
  | { type: "object"; entries: Array<[string, EncodedStorageValue]> };

export interface IndexedDbIndexSeed {
  keyPath: string | string[] | null;
  multiEntry: boolean;
  name: string;
  unique: boolean;
}

export interface IndexedDbRecordSeed {
  key: EncodedStorageValue;
  value: EncodedStorageValue;
}

export interface IndexedDbObjectStoreSeed {
  autoIncrement: boolean;
  indexes: IndexedDbIndexSeed[];
  keyPath: string | string[] | null;
  name: string;
  records: IndexedDbRecordSeed[];
}

export interface IndexedDbDatabaseSeed {
  name: string;
  objectStores: IndexedDbObjectStoreSeed[];
  version: number;
}

export interface CacheStorageEntrySeed {
  bodyBase64: string;
  cacheName: string;
  requestHeaders: Array<[string, string]>;
  requestUrl: string;
  responseHeaders: Array<[string, string]>;
  responseStatus: number;
  responseStatusText: string;
}

export interface EmbeddedStorageOriginSeed {
  cacheStorage?: CacheStorageEntrySeed[];
  indexedDb?: IndexedDbDatabaseSeed[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

export interface EmbeddedStorageSeed {
  origins: Record<string, EmbeddedStorageOriginSeed>;
  version: 2;
}

export interface SafeStorageAdapter {
  decryptString: (encrypted: Buffer) => string;
  encryptString: (plainText: string) => Buffer;
  isEncryptionAvailable: () => boolean;
}

interface EncryptedSessionStorageSeedStoreOptions {
  getBrowserUserDataDir: (roleId: string) => string;
  safeStorage: SafeStorageAdapter;
  writeFile?: typeof writeFile;
}

const SEED_FILE_NAME = ".rion-embedded-session-storage";
const LEGACY_SEED_VERSION = 1;
const SEED_VERSION = 2;

/**
 * Stores data which Electron cannot import directly from Chromium's profile
 * databases.  The historical name is retained so existing encrypted v1
 * session-storage files continue to work.
 */
export class EncryptedSessionStorageSeedStore {
  private readonly memorySeeds = new Map<string, EmbeddedStorageSeed>();
  private readonly writeFile: typeof writeFile;

  constructor(private readonly options: EncryptedSessionStorageSeedStoreOptions) {
    this.writeFile = options.writeFile ?? writeFile;
  }

  async save(roleId: string, value: EmbeddedStorageSeed | SessionStorageByOrigin): Promise<boolean> {
    const seed = normalizeEmbeddedStorageSeed(value);
    const path = this.getPath(roleId);

    if (!hasEmbeddedStorageSeedData(seed)) {
      this.memorySeeds.delete(roleId);
      return this.removePersistedSeed(path);
    }

    // The in-process fallback is intentional. Import remains optimistic when
    // Keychain/DPAPI is unavailable, but no plaintext data reaches disk.
    this.memorySeeds.set(roleId, cloneEmbeddedStorageSeed(seed));
    if (!this.isEncryptionAvailable()) {
      await this.removePersistedSeed(path);
      return false;
    }

    let temporaryPath: string | undefined;
    try {
      const encrypted = this.options.safeStorage.encryptString(JSON.stringify(seed));
      temporaryPath = `${path}.tmp`;
      await mkdir(this.options.getBrowserUserDataDir(roleId), { recursive: true });
      await this.writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await rename(temporaryPath, path);
      return true;
    } catch {
      await this.removePersistedSeed(path);
      if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
      return false;
    }
  }

  async load(roleId: string): Promise<EmbeddedStorageSeed | undefined> {
    const memorySeed = this.memorySeeds.get(roleId);
    if (memorySeed) return cloneEmbeddedStorageSeed(memorySeed);
    if (!this.isEncryptionAvailable()) return undefined;

    try {
      const encrypted = await readFile(this.getPath(roleId));
      const parsed = JSON.parse(this.options.safeStorage.decryptString(encrypted)) as unknown;
      const seed = normalizePersistedSeed(parsed);
      if (!hasEmbeddedStorageSeedData(seed)) return undefined;
      this.memorySeeds.set(roleId, cloneEmbeddedStorageSeed(seed));
      return seed;
    } catch {
      return undefined;
    }
  }

  async clear(roleId: string): Promise<boolean> {
    this.memorySeeds.delete(roleId);
    return this.removePersistedSeed(this.getPath(roleId));
  }

  private getPath(roleId: string): string {
    return join(this.options.getBrowserUserDataDir(roleId), SEED_FILE_NAME);
  }

  private isEncryptionAvailable(): boolean {
    try {
      return this.options.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private async removePersistedSeed(path: string): Promise<boolean> {
    try {
      await rm(path, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

export function createEmbeddedStorageSeed(
  sessionStorageByOrigin: SessionStorageByOrigin,
  durableByOrigin: Record<string, Pick<EmbeddedStorageOriginSeed, "cacheStorage" | "indexedDb">> = {},
  localStorageByOrigin: Record<string, Record<string, string>> = {}
): EmbeddedStorageSeed {
  return normalizeEmbeddedStorageSeed({
    origins: Object.fromEntries(
      [...new Set([
        ...Object.keys(sessionStorageByOrigin),
        ...Object.keys(durableByOrigin),
        ...Object.keys(localStorageByOrigin)
      ])]
        .map((origin) => [
          origin,
          {
            ...(sessionStorageByOrigin[origin] ? { sessionStorage: sessionStorageByOrigin[origin] } : {}),
            ...(durableByOrigin[origin] ?? {}),
            ...(localStorageByOrigin[origin] ? { localStorage: localStorageByOrigin[origin] } : {})
          }
        ])
    ),
    version: SEED_VERSION
  });
}

export function cloneEmbeddedStorageSeed(seed: EmbeddedStorageSeed): EmbeddedStorageSeed {
  return structuredClone(seed);
}

export function getSessionStorageByOrigin(seed: EmbeddedStorageSeed | undefined): SessionStorageByOrigin {
  if (!seed) return {};
  return Object.fromEntries(
    Object.entries(seed.origins)
      .filter(([, originSeed]) => Boolean(originSeed.sessionStorage && Object.keys(originSeed.sessionStorage).length > 0))
      .map(([origin, originSeed]) => [origin, { ...originSeed.sessionStorage }])
  );
}

export function hasPendingDurableStorage(seed: EmbeddedStorageSeed | undefined): boolean {
  return Boolean(seed && Object.values(seed.origins).some((origin) =>
    Object.keys(origin.localStorage ?? {}).length > 0 ||
    (origin.indexedDb?.length ?? 0) > 0 || (origin.cacheStorage?.length ?? 0) > 0
  ));
}

export function removeDurableStorageForOrigin(seed: EmbeddedStorageSeed, origin: string): EmbeddedStorageSeed {
  const next = cloneEmbeddedStorageSeed(seed);
  const originSeed = next.origins[origin];
  if (!originSeed) return next;
  delete originSeed.localStorage;
  delete originSeed.indexedDb;
  delete originSeed.cacheStorage;
  if (!originSeed.sessionStorage || Object.keys(originSeed.sessionStorage).length === 0) {
    delete next.origins[origin];
  }
  return next;
}

export function getPendingDurableOrigins(seed: EmbeddedStorageSeed | undefined): string[] {
  if (!seed) return [];
  return Object.entries(seed.origins)
    .filter(([, origin]) => Object.keys(origin.localStorage ?? {}).length > 0 ||
      (origin.indexedDb?.length ?? 0) > 0 || (origin.cacheStorage?.length ?? 0) > 0)
    .map(([origin]) => origin);
}

export function cloneSessionStorageByOrigin(values: SessionStorageByOrigin): SessionStorageByOrigin {
  return Object.fromEntries(
    Object.entries(values).map(([origin, storage]) => [origin, { ...storage }])
  );
}

export function normalizeSessionStorageByOrigin(value: unknown): SessionStorageByOrigin {
  const seed = normalizeEmbeddedStorageSeed(value);
  return getSessionStorageByOrigin(seed);
}

export function normalizeEmbeddedStorageSeed(value: unknown): EmbeddedStorageSeed {
  const originsInput = isRecord(value) && isRecord(value.origins) ? value.origins : value;
  if (!isRecord(originsInput)) return { origins: {}, version: SEED_VERSION };

  const origins: Record<string, EmbeddedStorageOriginSeed> = {};
  for (const [origin, rawOriginSeed] of Object.entries(originsInput)) {
    if (!isHttpOrigin(origin)) continue;
    const normalized = normalizeOriginSeed(rawOriginSeed);
    if (normalized) origins[origin] = normalized;
  }
  return { origins, version: SEED_VERSION };
}

function normalizePersistedSeed(value: unknown): EmbeddedStorageSeed {
  if (!isRecord(value)) return { origins: {}, version: SEED_VERSION };
  if (value.version === LEGACY_SEED_VERSION && isRecord(value.origins)) {
    return normalizeEmbeddedStorageSeed(value.origins);
  }
  if (value.version !== SEED_VERSION || !isRecord(value.origins)) {
    return { origins: {}, version: SEED_VERSION };
  }
  return normalizeEmbeddedStorageSeed(value);
}

function normalizeOriginSeed(value: unknown): EmbeddedStorageOriginSeed | undefined {
  const raw = isRecord(value) && ("localStorage" in value || "sessionStorage" in value || "indexedDb" in value || "cacheStorage" in value)
    ? value
    : { sessionStorage: value };
  const sessionStorage = normalizeStringRecord(raw.sessionStorage);
  const localStorage = normalizeStringRecord(raw.localStorage);
  const indexedDb = Array.isArray(raw.indexedDb) ? raw.indexedDb.filter(isIndexedDbDatabaseSeed) : [];
  const cacheStorage = Array.isArray(raw.cacheStorage) ? raw.cacheStorage.filter(isCacheStorageEntrySeed) : [];
  if (Object.keys(localStorage).length === 0 && Object.keys(sessionStorage).length === 0 && indexedDb.length === 0 && cacheStorage.length === 0) {
    return undefined;
  }
  return {
    ...(Object.keys(localStorage).length > 0 ? { localStorage } : {}),
    ...(Object.keys(sessionStorage).length > 0 ? { sessionStorage } : {}),
    ...(indexedDb.length > 0 ? { indexedDb: structuredClone(indexedDb) } : {}),
    ...(cacheStorage.length > 0 ? { cacheStorage: structuredClone(cacheStorage) } : {})
  };
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) as Record<string, string>;
}

function isIndexedDbDatabaseSeed(value: unknown): value is IndexedDbDatabaseSeed {
  if (!isRecord(value) || typeof value.name !== "string" || !isPositiveInteger(value.version) || !Array.isArray(value.objectStores)) {
    return false;
  }
  return value.objectStores.every(isIndexedDbObjectStoreSeed);
}

function isIndexedDbObjectStoreSeed(value: unknown): value is IndexedDbObjectStoreSeed {
  return isRecord(value) && typeof value.name === "string" && typeof value.autoIncrement === "boolean" &&
    isKeyPath(value.keyPath) && Array.isArray(value.indexes) && value.indexes.every(isIndexedDbIndexSeed) &&
    Array.isArray(value.records) && value.records.every(isIndexedDbRecordSeed);
}

function isIndexedDbIndexSeed(value: unknown): value is IndexedDbIndexSeed {
  return isRecord(value) && typeof value.name === "string" && isKeyPath(value.keyPath) &&
    typeof value.multiEntry === "boolean" && typeof value.unique === "boolean";
}

function isIndexedDbRecordSeed(value: unknown): value is IndexedDbRecordSeed {
  return isRecord(value) && isEncodedStorageValue(value.key) && isEncodedStorageValue(value.value);
}

function isCacheStorageEntrySeed(value: unknown): value is CacheStorageEntrySeed {
  return isRecord(value) && typeof value.cacheName === "string" && typeof value.requestUrl === "string" &&
    isHttpUrl(value.requestUrl) && typeof value.bodyBase64 === "string" && isPositiveInteger(value.responseStatus) &&
    typeof value.responseStatusText === "string" && isHeaderEntries(value.requestHeaders) && isHeaderEntries(value.responseHeaders);
}

function isEncodedStorageValue(value: unknown): value is EncodedStorageValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "array") return Array.isArray(value.values) && value.values.every(isEncodedStorageValue);
  if (value.type === "object") {
    return Array.isArray(value.entries) && value.entries.every((entry) =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && isEncodedStorageValue(entry[1])
    );
  }
  return ["undefined", "number", "bigint", "date", "array-buffer", "blob", "typed-array"].includes(value.type) &&
    (value.value === undefined || typeof value.value === "string") &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.mimeType === undefined || typeof value.mimeType === "string");
}

function isHeaderEntries(value: unknown): value is Array<[string, string]> {
  return Array.isArray(value) && value.every((entry) =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string"
  );
}

function isKeyPath(value: unknown): value is string | string[] | null {
  return value === null || typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function hasEmbeddedStorageSeedData(seed: EmbeddedStorageSeed): boolean {
  return Object.keys(seed.origins).length > 0;
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
