import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SessionStorageByOrigin = Record<string, Record<string, string>>;

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
const SEED_VERSION = 1;

export class EncryptedSessionStorageSeedStore {
  private readonly writeFile: typeof writeFile;

  constructor(private readonly options: EncryptedSessionStorageSeedStoreOptions) {
    this.writeFile = options.writeFile ?? writeFile;
  }

  async save(roleId: string, values: SessionStorageByOrigin): Promise<boolean> {
    const origins = normalizeSessionStorageByOrigin(values);
    const path = this.getPath(roleId);

    if (Object.keys(origins).length === 0) {
      return this.removePersistedSeed(path);
    }

    if (!this.isEncryptionAvailable()) {
      await this.removePersistedSeed(path);
      return false;
    }

    let temporaryPath: string | undefined;
    try {
      const encrypted = this.options.safeStorage.encryptString(JSON.stringify({
        origins,
        version: SEED_VERSION
      }));
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

  async load(roleId: string): Promise<SessionStorageByOrigin | undefined> {
    if (!this.isEncryptionAvailable()) {
      return undefined;
    }

    try {
      const encrypted = await readFile(this.getPath(roleId));
      const parsed = JSON.parse(this.options.safeStorage.decryptString(encrypted)) as unknown;
      if (!isRecord(parsed) || parsed.version !== SEED_VERSION || !isRecord(parsed.origins)) {
        return undefined;
      }
      const origins = normalizeSessionStorageByOrigin(parsed.origins);
      return Object.keys(origins).length > 0 ? origins : undefined;
    } catch {
      return undefined;
    }
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

export function cloneSessionStorageByOrigin(values: SessionStorageByOrigin): SessionStorageByOrigin {
  return Object.fromEntries(
    Object.entries(values).map(([origin, storage]) => [origin, { ...storage }])
  );
}

export function normalizeSessionStorageByOrigin(value: unknown): SessionStorageByOrigin {
  if (!isRecord(value)) return {};

  const origins: SessionStorageByOrigin = {};
  for (const [origin, storage] of Object.entries(value)) {
    if (!isHttpOrigin(origin) || !isRecord(storage)) continue;

    const normalizedStorage: Record<string, string> = {};
    for (const [key, storageValue] of Object.entries(storage)) {
      if (typeof storageValue === "string") {
        normalizedStorage[key] = storageValue;
      }
    }
    if (Object.keys(normalizedStorage).length > 0) {
      origins[origin] = normalizedStorage;
    }
  }
  return origins;
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
