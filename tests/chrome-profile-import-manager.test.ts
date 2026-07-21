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

async function createChromeProfileSource(
  root: string,
  profileNames: readonly string[]
): Promise<{ profileIds: string[]; source: string }> {
  const source = join(root, "Chrome User Data");
  const profileIds: string[] = [];
  const infoCache: Record<string, { name: string }> = {};

  for (const [index, name] of profileNames.entries()) {
    const profileId = index === 0 ? "Default" : `Profile ${index}`;
    profileIds.push(profileId);
    infoCache[profileId] = { name };
    await mkdir(join(source, profileId), { recursive: true });
  }
  await writeFile(
    join(source, "Local State"),
    JSON.stringify({ profile: { info_cache: infoCache } }),
    "utf8"
  );

  return { profileIds, source };
}

function createManager(options: {
  createImportId?: () => string;
  lstat?: ConstructorParameters<typeof ChromeProfileImportManager>[0]["lstat"];
  platform?: NodeJS.Platform;
  roleStore: ConstructorParameters<typeof ChromeProfileImportManager>[0]["roleStore"];
  source: string;
  userDataDir: string;
  prepareImportedSession?: ConstructorParameters<typeof ChromeProfileImportManager>[0]["prepareImportedSession"];
}): ChromeProfileImportManager {
  return new ChromeProfileImportManager({
    createImportId: options.createImportId ?? (() => "import-1"),
    gameStore: { getGame: async () => game },
    lstat: options.lstat,
    platform: options.platform ?? "darwin",
    roleStore: options.roleStore,
    ...(options.prepareImportedSession ? { prepareImportedSession: options.prepareImportedSession } : {}),
    showOpenDialog: async () => ({ canceled: false, filePaths: [options.source] }),
    userDataDir: options.userDataDir
  });
}

describe("ChromeProfileImportManager", () => {
  it.each([
    ["darwin", "/Users/test", undefined, "/Users/test/Library/Application Support/Google/Chrome"],
    ["win32", "C:/Users/test", "C:/Users/test/AppData/Local", "C:/Users/test/AppData/Local/Google/Chrome/User Data"]
  ] as const)("resolves the default Chrome User Data path on %s", (platform, home, localAppData, expected) => {
    expect(getDefaultChromeUserDataDirectory(platform, home, localAppData)).toBe(expected);
  });

  it("requests a graceful Chrome close through the injected platform service", async () => {
    const closeChrome = vi.fn().mockResolvedValue(undefined);
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const manager = new ChromeProfileImportManager({
      closeChrome,
      gameStore: { getGame: async () => game },
      roleStore: new RoleStore(root),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      userDataDir: root
    });

    await manager.closeChrome();
    expect(closeChrome).toHaveBeenCalledOnce();
  });

  it("copies only safe session data and never starts an external verifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default", "Local Storage"), { recursive: true });
    await mkdir(join(source, "Default", "Session Storage"), { recursive: true });
    await mkdir(join(source, "Default", "IndexedDB"), { recursive: true });
    await mkdir(join(source, "Default", "Service Worker", "CacheStorage"), { recursive: true });
    await mkdir(join(source, "Profile 1", "Network"), { recursive: true });
    await writeFile(join(source, "Local State"), JSON.stringify({
      profile: { info_cache: { Default: { name: "Primary" }, "Profile 1": { name: "Alt" } } }
    }), "utf8");
    await writeFile(join(source, "Default", "Cookies"), "cookie-db", "utf8");
    await writeFile(join(source, "Default", "Login Data"), "password-db", "utf8");
    await writeFile(join(source, "Default", "Web Data"), "autofill-db", "utf8");
    await writeFile(join(source, "Default", "Bookmarks"), "bookmarks", "utf8");
    await writeFile(join(source, "Default", "History"), "history", "utf8");
    await writeFile(join(source, "Default", "Extensions"), "extensions", "utf8");
    await writeFile(join(source, "Default", "Preferences"), "preferences", "utf8");
    await writeFile(join(source, "Default", "Local Storage", "leveldb.log"), "local", "utf8");
    await writeFile(join(source, "Default", "Session Storage", "session.log"), "session", "utf8");
    await writeFile(join(source, "Default", "IndexedDB", "auth.log"), "indexed", "utf8");
    await writeFile(join(source, "Default", "Service Worker", "CacheStorage", "cache.log"), "cache", "utf8");
    await writeFile(join(source, "Profile 1", "Network", "Cookies"), "other-cookie-db", "utf8");

    const roleStore = new RoleStore(userDataDir);
    const existingRole = await roleStore.createRole({ gameId: game.id, name: "Primary" });
    const manager = createManager({ roleStore, source, userDataDir });

    const preview = await manager.previewImport();
    expect(preview).toMatchObject({
      sourceLabel: basename(source),
      profiles: [
        { id: "Default", directoryName: "Default", name: "Primary" },
        { id: "Profile 1", directoryName: "Profile 1", name: "Alt" }
      ],
      warnings: [{ code: "passwords_excluded" }]
    });
    expect(preview).not.toHaveProperty("sourceUserDataDir");

    const progress: string[] = [];
    const result = await manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-1",
      profileIds: ["Default", "Profile 1"]
    }, (event) => progress.push(event.phase));

    expect(result.roles.map((role) => role.name)).toEqual(["Primary", "Alt"]);
    const importedRoles = await roleStore.listRoles();
    expect(importedRoles).toHaveLength(2);
    expect(importedRoles.every((role) => role.browserSessionSource === "chrome-profile")).toBe(true);
    expect(progress).toEqual(["preparing", "importing", "importing", "completed"]);

    const primary = importedRoles.find((role) => role.name === "Primary")!;
    expect(primary.id).toBe(existingRole.id);
    const primaryBrowserDir = roleStore.getRolePaths(primary.id).browserUserDataDir;
    const alternateBrowserDir = roleStore.getRolePaths(importedRoles.find((role) => role.name === "Alt")!.id)
      .browserUserDataDir;
    await expect(readFile(join(primaryBrowserDir, "Default", "Cookies"), "utf8")).resolves.toBe("cookie-db");
    await expect(readFile(join(alternateBrowserDir, "Default", "Network", "Cookies"), "utf8"))
      .resolves.toBe("other-cookie-db");
    await expect(readFile(join(primaryBrowserDir, "Default", "Local Storage", "leveldb.log"), "utf8"))
      .resolves.toBe("local");
    await expect(readFile(join(primaryBrowserDir, "Default", "Session Storage", "session.log"), "utf8"))
      .resolves.toBe("session");
    await expect(readFile(join(primaryBrowserDir, "Default", "IndexedDB", "auth.log"), "utf8"))
      .resolves.toBe("indexed");
    await expect(readFile(join(primaryBrowserDir, "Default", "Service Worker", "CacheStorage", "cache.log"), "utf8"))
      .resolves.toBe("cache");
    for (const relativePath of ["Bookmarks", "Extensions", "History", "Login Data", "Preferences", "Web Data"]) {
      await expect(access(join(primaryBrowserDir, "Default", relativePath))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(access(join(userDataDir, ".chrome-profile-import"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(userDataDir, "chrome-profile-import-transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a pending preview after the main import manager is recreated", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const { source } = await createChromeProfileSource(root, ["Primary"]);
    const userDataDir = join(root, "rion-data");
    const roleStore = new RoleStore(userDataDir);
    const firstManager = createManager({ roleStore, source, userDataDir });

    const preview = await firstManager.previewImport();
    expect(preview?.importId).toBe("import-1");
    await expect(access(join(userDataDir, "chrome-profile-import-previews.json"))).resolves.toBeUndefined();

    const restartedManager = createManager({ roleStore, source, userDataDir });
    await expect(restartedManager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: preview!.importId,
      profileIds: ["Default"]
    })).resolves.toMatchObject({ roles: [expect.objectContaining({ name: "Primary" })] });
    await expect(access(join(userDataDir, "chrome-profile-import-previews.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["SingletonCookie", "SingletonLock", "SingletonSocket"] as const)("rejects an active Chrome folder marked by %s", async (lockFile) => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const { source } = await createChromeProfileSource(root, ["Primary"]);
    const userDataDir = join(root, "rion-data");
    await writeFile(join(source, lockFile), "locked", "utf8");
    const manager = createManager({ platform: "win32", roleStore: new RoleStore(userDataDir), source, userDataDir });

    await expect(manager.previewImport()).rejects.toMatchObject({ code: "CHROME_RUNNING" });
  });

  it("rejects duplicate source profile names before changing roles", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const { source } = await createChromeProfileSource(root, ["Same", "same"]);
    const userDataDir = join(root, "rion-data");
    const roleStore = new RoleStore(userDataDir);
    const manager = createManager({ roleStore, source, userDataDir });

    await manager.previewImport();
    await expect(manager.applyImport({ consentAccepted: true, gameId: game.id, importId: "import-1", profileIds: ["Default", "Profile 1"] }))
      .rejects.toMatchObject({ code: "ROLE_NAME_CONFLICT" });
    await expect(roleStore.listRoles()).resolves.toEqual([]);
  });

  it("allows an imported role name already used by another game", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const { source } = await createChromeProfileSource(root, ["Same"]);
    const userDataDir = join(root, "rion-data");
    const roleStore = new RoleStore(userDataDir);
    await roleStore.createRole({ gameId: "game-2", name: "Same" });
    const manager = createManager({ roleStore, source, userDataDir });

    await manager.previewImport();
    await manager.applyImport({ consentAccepted: true, gameId: game.id, importId: "import-1", profileIds: ["Default"] });
    await expect(roleStore.listRoles()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ gameId: "game-1", name: "Same", browserSessionSource: "chrome-profile" }),
      expect.objectContaining({ gameId: "game-2", name: "Same" })
    ]));
  });

  it("rolls back role and browser changes when session injection fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const { source } = await createChromeProfileSource(root, ["Primary"]);
    const userDataDir = join(root, "rion-data");
    await writeFile(join(source, "Default", "Cookies"), "session", "utf8");
    const roleStore = new RoleStore(userDataDir);
    const manager = createManager({
      roleStore,
      source,
      userDataDir,
      prepareImportedSession: async () => { throw new Error("simulated injection failure"); }
    });

    await manager.previewImport();
    await expect(manager.applyImport({ consentAccepted: true, gameId: game.id, importId: "import-1", profileIds: ["Default"] }))
      .rejects.toThrow("simulated injection failure");
    await expect(roleStore.listRoles()).resolves.toEqual([]);
    await expect(access(join(userDataDir, "chrome-profile-import-previews.json"))).resolves.toBeUndefined();
    await expect(access(join(userDataDir, ".chrome-profile-import"))).rejects.toMatchObject({ code: "ENOENT" });

    const recoveredRole = await roleStore.createRole({ gameId: game.id, name: "Recovered" });
    await writeFile(join(userDataDir, "chrome-profile-import-transaction.json"), JSON.stringify({ importId: "restart", roleIds: [recoveredRole.id] }), "utf8");
    await mkdir(join(userDataDir, ".chrome-profile-import", "restart"), { recursive: true });
    await recoverChromeProfileImport(userDataDir, roleStore);
    await expect(roleStore.listRoles()).resolves.toEqual([]);
  });

  it("restores an overwritten role and its browser data when the import fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const { source } = await createChromeProfileSource(root, ["Primary"]);
    const userDataDir = join(root, "rion-data");
    await writeFile(join(source, "Default", "Cookies"), "imported", "utf8");
    const roleStore = new RoleStore(userDataDir);
    const existingRole = await roleStore.createRole({ gameId: game.id, name: "Primary", notes: "Original" });
    await writeFile(join(roleStore.getRolePaths(existingRole.id).browserUserDataDir, "original.txt"), "keep", "utf8");
    const failingRoleStore = {
      createRole: roleStore.createRole.bind(roleStore),
      deleteRole: roleStore.deleteRole.bind(roleStore),
      getRolePaths: roleStore.getRolePaths.bind(roleStore),
      listRoles: roleStore.listRoles.bind(roleStore),
      replaceRolesForImport: roleStore.replaceRolesForImport.bind(roleStore),
      updateBrowserSessionSource: roleStore.updateBrowserSessionSource.bind(roleStore),
      updateRole: async () => { throw new Error("simulated overwrite failure"); }
    };
    const manager = createManager({ roleStore: failingRoleStore, source, userDataDir });

    await manager.previewImport();
    await expect(manager.applyImport({ consentAccepted: true, gameId: game.id, importId: "import-1", profileIds: ["Default"] }))
      .rejects.toThrow("simulated overwrite failure");
    await expect(roleStore.getRole(existingRole.id)).resolves.toMatchObject({
      id: existingRole.id,
      notes: "Original",
      browserSessionSource: "embedded"
    });
    await expect(readFile(join(roleStore.getRolePaths(existingRole.id).browserUserDataDir, "original.txt"), "utf8"))
      .resolves.toBe("keep");
  });

  it("rejects symbolic links before creating a role", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const { source } = await createChromeProfileSource(root, ["Primary"]);
    const userDataDir = join(root, "rion-data");
    await writeFile(join(source, "Default", "Cookies"), "symlink placeholder", "utf8");
    const roleStore = new RoleStore(userDataDir);
    const manager = createManager({
      lstat: vi.fn(async (path: string) => {
        const isCookieLink = path.endsWith(join("Default", "Cookies"));
        return {
          isDirectory: () => path === source,
          isFile: () => !isCookieLink && path !== source,
          isSymbolicLink: () => isCookieLink
        } as never;
      }) as never,
      roleStore,
      source,
      userDataDir
    });

    await manager.previewImport();
    await expect(manager.applyImport({ consentAccepted: true, gameId: game.id, importId: "import-1", profileIds: ["Default"] }))
      .rejects.toMatchObject({ code: "PROFILE_INVALID" });
    await expect(roleStore.listRoles()).resolves.toEqual([]);
  });
});
