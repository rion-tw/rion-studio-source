import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  ChromeProfileImportManager,
  getDefaultChromeUserDataDirectory,
  recoverChromeProfileImport
} from "../src/main/browser/ChromeProfileImportManager";
import { RoleStore } from "../src/main/roles/RoleStore";
import type { Game } from "../src/shared/types";

const game: Game = {
  id: "game-1",
  source: "custom",
  name: "Example game",
  defaultLaunchUrl: "https://example.test/play",
  browserLaunchMode: "inherit",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("ChromeProfileImportManager", () => {
  it.each([
    ["darwin", "/Users/test", undefined, "/Users/test/Library/Application Support/Google/Chrome"],
    ["win32", "C:/Users/test", "C:/Users/test/AppData/Local", "C:/Users/test/AppData/Local/Google/Chrome/User Data"]
  ] as const)("resolves the default Chrome User Data path on %s", (platform, home, localAppData, expected) => {
    expect(getDefaultChromeUserDataDirectory(platform, home, localAppData)).toBe(expected);
  });

  it("previews profiles without exposing the source path and imports only the allowlisted session data", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default", "Local Storage"), { recursive: true });
    await mkdir(join(source, "Profile 1", "Network"), { recursive: true });
    await writeFile(
      join(source, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: "Primary" },
            "Profile 1": { name: "Alt" }
          }
        }
      }),
      "utf8"
    );
    await writeFile(join(source, "Default", "Cookies"), "cookie-db", "utf8");
    await writeFile(join(source, "Default", "Login Data"), "password-db", "utf8");
    await writeFile(join(source, "Default", "Web Data"), "autofill-db", "utf8");
    await writeFile(join(source, "Default", "Local Storage", "leveldb.log"), "session-storage", "utf8");
    await writeFile(join(source, "Profile 1", "Network", "Cookies"), "other-cookie-db", "utf8");

    const roleStore = new RoleStore(userDataDir);
    await roleStore.createRole({ gameId: game.id, name: "Primary" });
    const session = { cookies: { set: vi.fn().mockResolvedValue(undefined) } };
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [source] }));
    const injectEmbeddedStorage = vi.fn(async () => undefined);
    const readChromeSession = vi.fn()
      .mockResolvedValueOnce({
        authState: "authenticated" as const,
        cookies: [{ domain: "example.test", name: "session", value: "secret", path: "/" }],
        indexedDb: { auth: "present" },
        localStorage: { session: "present" }
      })
      .mockResolvedValueOnce({
        authState: "authenticated" as const,
        cookies: [{ domain: "example.test", name: "session", value: "secret", path: "/" }],
        localStorage: { session: "present" }
      });
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-1",
      gameStore: { getGame: async () => game },
      getSession: () => session as never,
      homeDirectory: "/Users/test",
      injectEmbeddedStorage,
      platform: "darwin",
      readChromeSession,
      roleStore,
      showOpenDialog,
      userDataDir
    });

    const preview = await manager.previewImport();

    expect(preview).toMatchObject({
      importId: "import-1",
      sourceLabel: basename(source),
      profiles: [
        { id: "Default", directoryName: "Default", name: "Primary" },
        { id: "Profile 1", directoryName: "Profile 1", name: "Alt" }
      ],
      warnings: [{ code: "passwords_excluded" }]
    });
    expect(preview).not.toHaveProperty("sourceUserDataDir");
    expect(showOpenDialog).toHaveBeenCalledWith({
      defaultPath: "/Users/test/Library/Application Support/Google/Chrome",
      properties: ["openDirectory"],
      title: "Choose Chrome User Data folder"
    });

    const result = await manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-1",
      profileIds: ["Default", "Profile 1"]
    });
    const roles = await roleStore.listRoles();
    const importedRoles = roles.filter((role) => role.notes.includes("local Chrome"));

    expect(importedRoles).toHaveLength(2);
    expect(importedRoles.map((role) => role.name)).toEqual(["Primary (2)", "Alt"]);
    expect(importedRoles.every((role) => role.authState === "authenticated")).toBe(true);
    expect(importedRoles.map((role) => role.preferredBrowserLaunchMode)).toEqual(["external", "embedded"]);
    expect(result.results.map((item) => [item.embedded, item.external])).toEqual([
      ["unavailable", "authenticated"],
      ["authenticated", "authenticated"]
    ]);
    expect(readChromeSession).toHaveBeenCalledTimes(2);
    expect(session.cookies.set).toHaveBeenCalledTimes(2);
    expect(injectEmbeddedStorage).toHaveBeenCalledTimes(2);
    await expect(readFile(join(roleStore.getRolePaths(importedRoles[0].id).browserUserDataDir, "Default", "Cookies"), "utf8"))
      .resolves.toBe("cookie-db");
    await expect(access(join(roleStore.getRolePaths(importedRoles[0].id).browserUserDataDir, "Default", "Login Data")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(userDataDir, ".chrome-profile-import"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(userDataDir, "chrome-profile-import-transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an active Chrome data folder and cleans a discarded staging directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default"), { recursive: true });
    await writeFile(join(source, "SingletonLock"), "locked", "utf8");

    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-2",
      gameStore: { getGame: async () => game },
      platform: "win32",
      roleStore: new RoleStore(userDataDir),
      showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
      userDataDir
    });

    await expect(manager.previewImport()).rejects.toMatchObject({
      code: "CHROME_RUNNING"
    });

    await mkdir(join(userDataDir, ".chrome-profile-import", "import-2"), { recursive: true });
    await writeFile(join(userDataDir, "chrome-profile-import-transaction.json"), "journal", "utf8");
    await manager.discardImport("import-2");
    await expect(access(join(userDataDir, ".chrome-profile-import", "import-2"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(userDataDir, "chrome-profile-import-transaction.json"))).resolves.toBeUndefined();
  });

  it("rolls back roles when a staged import fails and recovers journaled roles after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default"), { recursive: true });
    await writeFile(join(source, "Local State"), "{}", "utf8");
    await writeFile(join(source, "Default", "Preferences"), "{}", "utf8");
    const roleStore = new RoleStore(userDataDir);
    const failingRoleStore = {
      createRole: roleStore.createRole.bind(roleStore),
      deleteRole: roleStore.deleteRole.bind(roleStore),
      getRolePaths: roleStore.getRolePaths.bind(roleStore),
      listRoles: roleStore.listRoles.bind(roleStore),
      updateAuthState: roleStore.updateAuthState.bind(roleStore),
      updateRole: async () => {
        throw new Error("simulated role preference failure");
      }
    };
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-3",
      gameStore: { getGame: async () => game },
      platform: "darwin",
      readChromeSession: async () => ({
        authState: "authenticated" as const,
        cookies: [],
        localStorage: {}
      }),
      roleStore: failingRoleStore,
      showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
      userDataDir
    });

    await manager.previewImport();
    await expect(manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-3",
      profileIds: ["Default"]
    })).rejects.toThrow("simulated role preference failure");
    await expect(roleStore.listRoles()).resolves.toEqual([]);
    await expect(access(join(userDataDir, ".chrome-profile-import"))).rejects.toMatchObject({ code: "ENOENT" });

    const recoveredRole = await roleStore.createRole({ gameId: game.id, name: "Recovered" });
    await writeFile(
      join(userDataDir, "chrome-profile-import-transaction.json"),
      JSON.stringify({ importId: "after-restart", roleIds: [recoveredRole.id] }),
      "utf8"
    );
    await mkdir(join(userDataDir, ".chrome-profile-import", "after-restart"), { recursive: true });
    await recoverChromeProfileImport(userDataDir, roleStore);
    await expect(roleStore.listRoles()).resolves.toEqual([]);
    await expect(access(join(userDataDir, "chrome-profile-import-transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symbolic links before creating a role", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default"), { recursive: true });
    await writeFile(join(source, "Local State"), "{}", "utf8");
    await writeFile(join(source, "Default", "Cookies"), "symlink placeholder", "utf8");
    const roleStore = new RoleStore(userDataDir);
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-4",
      gameStore: { getGame: async () => game },
      lstat: vi.fn(async (path: string) => {
        const isCookieLink = path.endsWith(join("Default", "Cookies"));
        return {
          isDirectory: () => path === source,
          isFile: () => !isCookieLink && path !== source,
          isSymbolicLink: () => isCookieLink
        } as never;
      }) as never,
      platform: "darwin",
      roleStore,
      showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
      userDataDir
    });

    await manager.previewImport();
    await expect(manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-4",
      profileIds: ["Default"]
    })).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    await expect(roleStore.listRoles()).resolves.toEqual([]);
  });
});
