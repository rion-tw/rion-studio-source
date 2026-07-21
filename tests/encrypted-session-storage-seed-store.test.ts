import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  EncryptedSessionStorageSeedStore,
  type SafeStorageAdapter
} from "../src/main/browser/EncryptedSessionStorageSeedStore";

const seedFileName = ".rion-embedded-session-storage";

describe("EncryptedSessionStorageSeedStore", () => {
  it("encrypts and reloads per-origin session storage outside the Chrome profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-session-seed-"));
    const safeStorage = createSafeStorage();
    const store = new EncryptedSessionStorageSeedStore({
      getBrowserUserDataDir: (roleId) => join(root, roleId, "browser"),
      safeStorage
    });
    const values = {
      "https://accounts.example.test": { loginStep: "complete" },
      "https://game.example.test": { activeCharacter: "character-1", gameSession: "opaque-token" }
    };

    await expect(store.save("role-1", values)).resolves.toBe(true);
    await expect(store.load("role-1")).resolves.toEqual(values);

    const persisted = await readFile(join(root, "role-1", "browser", seedFileName), "utf8");
    expect(persisted).not.toContain("opaque-token");
    expect(safeStorage.encryptString).toHaveBeenCalledOnce();
    expect(safeStorage.decryptString).toHaveBeenCalledOnce();
  });

  it("replaces a prior seed with no seed data", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-session-seed-"));
    const store = new EncryptedSessionStorageSeedStore({
      getBrowserUserDataDir: (roleId) => join(root, roleId, "browser"),
      safeStorage: createSafeStorage()
    });
    const path = join(root, "role-1", "browser", seedFileName);

    await store.save("role-1", { "https://game.example.test": { gameSession: "opaque-token" } });
    await expect(store.save("role-1", {})).resolves.toBe(true);
    await expect(store.load("role-1")).resolves.toBeUndefined();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps no persistent seed when system encryption is unavailable or writing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-session-seed-"));
    const getBrowserUserDataDir = (roleId: string) => join(root, roleId, "browser");
    const persistedStore = new EncryptedSessionStorageSeedStore({
      getBrowserUserDataDir,
      safeStorage: createSafeStorage()
    });
    await persistedStore.save("role-1", { "https://game.example.test": { session: "stale-token" } });

    const unavailableStorage = createSafeStorage(false);
    const unavailableStore = new EncryptedSessionStorageSeedStore({
      getBrowserUserDataDir,
      safeStorage: unavailableStorage
    });

    await expect(unavailableStore.save("role-1", { "https://game.example.test": { session: "opaque-token" } }))
      .resolves.toBe(false);
    await expect(unavailableStore.load("role-1")).resolves.toBeUndefined();
    await expect(persistedStore.load("role-1")).resolves.toBeUndefined();
    expect(unavailableStorage.encryptString).not.toHaveBeenCalled();

    await persistedStore.save("role-2", { "https://game.example.test": { session: "stale-token" } });
    const writeFile = vi.fn().mockRejectedValue(new Error("keychain write failed"));
    const failedStore = new EncryptedSessionStorageSeedStore({
      getBrowserUserDataDir,
      safeStorage: createSafeStorage(),
      writeFile: writeFile as never
    });

    await expect(failedStore.save("role-2", { "https://game.example.test": { session: "opaque-token" } }))
      .resolves.toBe(false);
    expect(writeFile).toHaveBeenCalledOnce();
    await expect(persistedStore.load("role-2")).resolves.toBeUndefined();
  });
});

function createSafeStorage(available = true): SafeStorageAdapter & {
  decryptString: ReturnType<typeof vi.fn>;
  encryptString: ReturnType<typeof vi.fn>;
} {
  return {
    decryptString: vi.fn((encrypted: Buffer) => Buffer.from(encrypted.toString(), "base64").toString("utf8")),
    encryptString: vi.fn((plainText: string) => Buffer.from(Buffer.from(plainText, "utf8").toString("base64"))),
    isEncryptionAvailable: vi.fn(() => available)
  };
}
