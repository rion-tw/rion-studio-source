import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  ChromeProfileImportManager,
  buildChromeProfileImportChromeArgs,
  type ChromeProfileImportLoginDataTransferSummary,
  getDefaultChromeUserDataDirectory,
  readChromeLoginDataWithCdp,
  recoverChromeProfileImport
} from "../src/main/browser/ChromeProfileImportManager";
import { RoleStore } from "../src/main/roles/RoleStore";
import type { Game } from "../src/shared/types";

const game: Game = {
  id: "game-1",
  source: "custom",
  name: "Example game",
  defaultLaunchUrl: "https://example.test/play",
  loginUrl: "https://accounts.example.test/login",
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

describe("ChromeProfileImportManager", () => {
  it.each([
    ["darwin", "/Users/test", undefined, "/Users/test/Library/Application Support/Google/Chrome"],
    ["win32", "C:/Users/test", "C:/Users/test/AppData/Local", "C:/Users/test/AppData/Local/Google/Chrome/User Data"]
  ] as const)("resolves the default Chrome User Data path on %s", (platform, home, localAppData, expected) => {
    expect(getDefaultChromeUserDataDirectory(platform, home, localAppData)).toBe(expected);
  });

  it("requests a graceful Chrome close through the injected platform service", async () => {
    const closeChrome = vi.fn().mockResolvedValue(undefined);
    const manager = new ChromeProfileImportManager({
      closeChrome,
      gameStore: { getGame: async () => game },
      roleStore: new RoleStore(await mkdtemp(join(tmpdir(), "rion-chrome-import-"))),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      userDataDir: await mkdtemp(join(tmpdir(), "rion-chrome-import-"))
    });

    await manager.closeChrome();

    expect(closeChrome).toHaveBeenCalledOnce();
  });

  it("normalizes graceful Chrome close failures", async () => {
    const manager = new ChromeProfileImportManager({
      closeChrome: async () => {
        throw new Error("close failed");
      },
      gameStore: { getGame: async () => game },
      roleStore: new RoleStore(await mkdtemp(join(tmpdir(), "rion-chrome-import-"))),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      userDataDir: await mkdtemp(join(tmpdir(), "rion-chrome-import-"))
    });

    await expect(manager.closeChrome()).rejects.toMatchObject({
      code: "CHROME_CLOSE_FAILED"
    });
  });

  it("previews profiles without exposing the source path and imports only Cookie login data", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default", "Local Storage"), { recursive: true });
    await mkdir(join(source, "Default", "Session Storage"), { recursive: true });
    await mkdir(join(source, "Default", "IndexedDB"), { recursive: true });
    await mkdir(join(source, "Default", "Service Worker", "CacheStorage"), { recursive: true });
    await mkdir(join(source, "Profile 1", "Network"), { recursive: true });
    await writeFile(
      join(source, "Local State"),
      JSON.stringify({
        profile: {
          last_used: "Profile 1",
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
    await writeFile(join(source, "Default", "Bookmarks"), "bookmarks", "utf8");
    await writeFile(join(source, "Default", "Preferences"), "preferences", "utf8");
    await writeFile(join(source, "Default", "Local Storage", "leveldb.log"), "session-storage", "utf8");
    await writeFile(join(source, "Default", "Session Storage", "session.log"), "session-storage", "utf8");
    await writeFile(join(source, "Default", "IndexedDB", "auth.log"), "indexed-db", "utf8");
    await writeFile(
      join(source, "Default", "Service Worker", "CacheStorage", "cache.log"),
      "cache-storage",
      "utf8"
    );
    await writeFile(join(source, "Profile 1", "Network", "Cookies"), "other-cookie-db", "utf8");

    const roleStore = new RoleStore(userDataDir);
    const existingRole = await roleStore.createRole({ gameId: game.id, name: "Primary" });
    const cookieSet = vi.fn()
      .mockRejectedValueOnce(new Error("cookie transfer failed"))
      .mockResolvedValue(undefined);
    const cookieGet = vi.fn().mockResolvedValue([
      { domain: ".example.test", name: "session", path: "/" }
    ]);
    const flushStorageData = vi.fn();
    const session = { cookies: { get: cookieGet, set: cookieSet }, flushStorageData };
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [source] }));
    const resetEmbeddedSession = vi.fn(async () => undefined);
    const transferSummaries: ChromeProfileImportLoginDataTransferSummary[] = [];
    const readChromeLoginData = vi.fn()
      .mockResolvedValueOnce({
        cookies: [
          { domain: ".example.test", name: "session", value: "secret", path: "/", secure: true },
          { domain: "accounts.example.test", name: "sso", value: "secret", path: "/", secure: true }
        ]
      })
      .mockResolvedValueOnce({
        cookies: [
          { domain: ".example.test", name: "session", value: "secret", path: "/", secure: true },
          { domain: "accounts.example.test", name: "sso", value: "secret", path: "/", secure: true }
        ]
      });
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-1",
      gameStore: { getGame: async () => game },
      getSession: () => session as never,
      homeDirectory: "/Users/test",
      onLoginDataTransfer: (summary) => transferSummaries.push(summary),
      platform: "darwin",
      readChromeLoginData,
      resetEmbeddedSession,
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

    const progressEvents: Array<{
      completedProfileCount: number;
      phase: string;
      totalProfileCount: number;
    }> = [];
    const result = await manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-1",
      profileIds: ["Default", "Profile 1"]
    }, (progress) => progressEvents.push(progress));
    const roles = await roleStore.listRoles();
    const importedRoles = roles.filter((role) => role.notes.includes("local Chrome"));

    expect(importedRoles).toHaveLength(2);
    expect(importedRoles.map((role) => role.name)).toEqual(["Primary", "Alt"]);
    expect(importedRoles.find((role) => role.name === "Primary")?.id).toBe(existingRole.id);
    expect(importedRoles.every((role) => role.authState === "authenticated")).toBe(true);
    expect(importedRoles.every((role) => role.lastAuthCheckAt && role.lastSuccessfulLoginAt)).toBe(true);
    expect(result).not.toHaveProperty("results");
    expect(result).not.toHaveProperty("verifications");
    expect(result).not.toHaveProperty("warnings");
    expect(result.roles.map((role) => role.name)).toEqual(["Primary", "Alt"]);
    expect(readChromeLoginData).toHaveBeenCalledTimes(2);
    expect(readChromeLoginData).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ launchUrl: game.defaultLaunchUrl }),
      [game.defaultLaunchUrl, game.loginUrl]
    );
    expect(cookieSet).toHaveBeenCalledTimes(4);
    expect(cookieSet).toHaveBeenCalledWith(expect.objectContaining({
      domain: ".example.test",
      url: "https://example.test/"
    }));
    expect(cookieSet).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://accounts.example.test/"
    }));
    expect(resetEmbeddedSession).toHaveBeenCalledOnce();
    expect(flushStorageData).toHaveBeenCalledTimes(2);
    expect(progressEvents).toEqual([
      expect.objectContaining({ completedProfileCount: 0, phase: "preparing", totalProfileCount: 2 }),
      expect.objectContaining({ completedProfileCount: 0, phase: "importing", totalProfileCount: 2 }),
      expect.objectContaining({ completedProfileCount: 0, phase: "importing", totalProfileCount: 2 }),
      expect.objectContaining({ completedProfileCount: 1, phase: "importing", totalProfileCount: 2 }),
      expect.objectContaining({ completedProfileCount: 2, phase: "importing", totalProfileCount: 2 }),
      expect.objectContaining({ completedProfileCount: 2, phase: "completed", totalProfileCount: 2 })
    ]);
    expect(transferSummaries).toEqual([
      expect.objectContaining({
        failedItemCount: 1,
        readbackFailed: false,
        readFailed: false,
        resetFailed: false,
        sourceItemCount: 2,
        visibleItemCount: 1,
        writtenItemCount: 1
      }),
      expect.objectContaining({
        failedItemCount: 0,
        readbackFailed: false,
        resetFailed: false,
        sourceItemCount: 2,
        visibleItemCount: 1,
        writtenItemCount: 2
      })
    ]);
    const primaryBrowserDir = roleStore.getRolePaths(importedRoles.find((role) => role.name === "Primary")!.id)
      .browserUserDataDir;
    const alternateBrowserDir = roleStore.getRolePaths(importedRoles.find((role) => role.name === "Alt")!.id)
      .browserUserDataDir;
    await expect(readFile(join(primaryBrowserDir, "Default", "Cookies"), "utf8"))
      .resolves.toBe("cookie-db");
    await expect(readFile(join(alternateBrowserDir, "Default", "Network", "Cookies"), "utf8"))
      .resolves.toBe("other-cookie-db");
    for (const relativePath of [
      "Bookmarks",
      "IndexedDB",
      "Local Storage",
      "Login Data",
      "Preferences",
      "Service Worker",
      "Session Storage",
      "Web Data"
    ]) {
      await expect(access(join(primaryBrowserDir, "Default", relativePath)))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(access(join(userDataDir, ".chrome-profile-import"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(userDataDir, "chrome-profile-import-transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("opens the copied Default Chrome profile in unified headless mode", () => {
    expect(buildChromeProfileImportChromeArgs("/tmp/rion-role/browser", "https://example.test/play")).toEqual([
      "--user-data-dir=/tmp/rion-role/browser",
      "--profile-directory=Default",
      "--headless",
      "--app=https://example.test/play",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0"
    ]);
  });

  it("reads Cookies from at most three imported Chrome profiles concurrently", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const userDataDir = join(root, "rion-data");
    const { profileIds, source } = await createChromeProfileSource(
      root,
      ["Role 1", "Role 2", "Role 3", "Role 4", "Role 5"]
    );
    const roleStore = new RoleStore(userDataDir);
    const releases: Array<() => void> = [];
    let activeReadCount = 0;
    let maxActiveReadCount = 0;
    const readChromeLoginData = vi.fn(async () => {
      activeReadCount += 1;
      maxActiveReadCount = Math.max(maxActiveReadCount, activeReadCount);
      await new Promise<void>((resolve) => releases.push(resolve));
      activeReadCount -= 1;
      return { cookies: [] };
    });
    const progressCounts: number[] = [];
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-concurrent",
      gameStore: { getGame: async () => game },
      platform: "darwin",
      readChromeLoginData,
      roleStore,
      showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
      userDataDir
    });

    await manager.previewImport();
    const importPromise = manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-concurrent",
      profileIds
    }, (progress) => progressCounts.push(progress.completedProfileCount));

    await vi.waitFor(() => expect(readChromeLoginData).toHaveBeenCalledTimes(3));
    expect(maxActiveReadCount).toBe(3);

    releases.shift()?.();
    await vi.waitFor(() => expect(readChromeLoginData).toHaveBeenCalledTimes(4));
    releases.shift()?.();
    await vi.waitFor(() => expect(readChromeLoginData).toHaveBeenCalledTimes(5));
    releases.splice(0).forEach((release) => release());

    await expect(importPromise).resolves.toMatchObject({ roles: expect.any(Array) });
    expect(maxActiveReadCount).toBe(3);
    expect(readChromeLoginData).toHaveBeenCalledTimes(5);
    expect(await roleStore.listRoles()).toHaveLength(5);
    expect(progressCounts.at(-1)).toBe(5);
    expect(progressCounts.every((count, index) => index === 0 || count >= progressCounts[index - 1])).toBe(true);
  });

  it("waits for active Cookie readers before rolling back and stops dispatching queued profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const userDataDir = join(root, "rion-data");
    const { profileIds, source } = await createChromeProfileSource(
      root,
      ["Role 1", "Role 2", "Role 3", "Role 4", "Role 5"]
    );
    const roleStore = new RoleStore(userDataDir);
    const releases: Array<() => void> = [];
    let readCallCount = 0;
    const readChromeLoginData = vi.fn(async () => {
      const callIndex = readCallCount;
      readCallCount += 1;
      if (callIndex > 0) {
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      return { cookies: [] };
    });
    let authUpdateCount = 0;
    const failingRoleStore = {
      createRole: roleStore.createRole.bind(roleStore),
      deleteRole: roleStore.deleteRole.bind(roleStore),
      getRolePaths: roleStore.getRolePaths.bind(roleStore),
      listRoles: roleStore.listRoles.bind(roleStore),
      replaceRolesForImport: roleStore.replaceRolesForImport.bind(roleStore),
      updateAuthState: async (...args: Parameters<RoleStore["updateAuthState"]>) => {
        authUpdateCount += 1;
        if (authUpdateCount === 1) throw new Error("simulated concurrent auth failure");
        return roleStore.updateAuthState(...args);
      },
      updateRole: roleStore.updateRole.bind(roleStore)
    };
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-concurrent-failure",
      gameStore: { getGame: async () => game },
      platform: "win32",
      readChromeLoginData,
      roleStore: failingRoleStore,
      showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
      userDataDir
    });

    await manager.previewImport();
    const importPromise = manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-concurrent-failure",
      profileIds
    });
    const rejection = expect(importPromise).rejects.toThrow("simulated concurrent auth failure");

    await vi.waitFor(() => expect(readChromeLoginData).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(authUpdateCount).toBe(1));
    await expect(roleStore.listRoles()).resolves.toHaveLength(5);
    expect(releases).toHaveLength(2);

    releases.splice(0).forEach((release) => release());
    await rejection;

    expect(readChromeLoginData).toHaveBeenCalledTimes(3);
    await expect(roleStore.listRoles()).resolves.toEqual([]);
    await expect(access(join(userDataDir, ".chrome-profile-import"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads each imported Chrome profile once", async () => {
    const snapshot = {
      cookies: [{ name: "session", value: "initial" }]
    };
    const readOnce = vi.fn().mockResolvedValue(snapshot);

    const result = await readChromeLoginDataWithCdp(
      "/profiles/role-1/browser",
      { launchUrl: game.defaultLaunchUrl },
      [game.defaultLaunchUrl],
      { readOnce }
    );

    expect(readOnce).toHaveBeenCalledOnce();
    expect(result).toEqual(snapshot);
  });

  it("marks imported roles authenticated when login data transfer fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default"), { recursive: true });
    await writeFile(
      join(source, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Primary" } } } }),
      "utf8"
    );
    const roleStore = new RoleStore(userDataDir);
    const transferSummaries: ChromeProfileImportLoginDataTransferSummary[] = [];
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-login-warning",
      gameStore: { getGame: async () => game },
      getSession: () => ({
        cookies: {
          get: vi.fn().mockResolvedValue([]),
          set: vi.fn().mockResolvedValue(undefined)
        },
        flushStorageData: vi.fn()
      }) as never,
      onLoginDataTransfer: (summary) => transferSummaries.push(summary),
      platform: "darwin",
      readChromeLoginData: vi.fn().mockRejectedValue(new Error("Chrome data unavailable")),
      roleStore,
      showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
      userDataDir
    });

    await manager.previewImport();
    const result = await manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-login-warning",
      profileIds: ["Default"]
    }, () => {
      throw new Error("renderer closed");
    });

    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].authState).toBe("authenticated");
    expect(transferSummaries).toEqual([
      expect.objectContaining({ readFailed: true, roleId: result.roles[0].id })
    ]);
  });

  it("marks imported roles authenticated when Cookie flushing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default"), { recursive: true });
    await writeFile(
      join(source, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Primary" } } } }),
      "utf8"
    );
    const roleStore = new RoleStore(userDataDir);
    const transferSummaries: ChromeProfileImportLoginDataTransferSummary[] = [];
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-transfer-warning",
      gameStore: { getGame: async () => game },
      getSession: () => ({
        cookies: {
          get: vi.fn().mockResolvedValue([]),
          set: vi.fn().mockResolvedValue(undefined)
        },
        flushStorageData: vi.fn().mockRejectedValue(new Error("flush failed"))
      }) as never,
      onLoginDataTransfer: (summary) => transferSummaries.push(summary),
      platform: "darwin",
      readChromeLoginData: vi.fn().mockResolvedValue({
        cookies: [{ domain: ".example.test", name: "session", path: "/", value: "secret" }]
      }),
      roleStore,
      showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
      userDataDir
    });

    await manager.previewImport();
    const result = await manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-transfer-warning",
      profileIds: ["Default"]
    });

    expect(result.roles[0].authState).toBe("authenticated");
    expect(transferSummaries).toEqual([
      expect.objectContaining({
        flushFailed: true,
        readFailed: false
      })
    ]);
  });

  it.each(["SingletonCookie", "SingletonLock", "SingletonSocket"] as const)("rejects an active Chrome data folder marked by %s and cleans a discarded staging directory", async (lockFile) => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default"), { recursive: true });
    await writeFile(join(source, lockFile), "locked", "utf8");

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

  it("rejects duplicate source profile names before changing roles", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default"), { recursive: true });
    await mkdir(join(source, "Profile 1"), { recursive: true });
    await writeFile(
      join(source, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: "Same" },
            "Profile 1": { name: "same" }
          }
        }
      }),
      "utf8"
    );
    const roleStore = new RoleStore(userDataDir);
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-source-conflict",
      gameStore: { getGame: async () => game },
      platform: "darwin",
      roleStore,
      showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
      userDataDir
    });

    await manager.previewImport();
    await expect(manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-source-conflict",
      profileIds: ["Default", "Profile 1"]
    })).rejects.toMatchObject({ code: "ROLE_NAME_CONFLICT" });
    await expect(roleStore.listRoles()).resolves.toEqual([]);
    await expect(access(join(userDataDir, ".chrome-profile-import"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows an imported role name already used by another game", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default"), { recursive: true });
    await writeFile(
      join(source, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Same" } } } }),
      "utf8"
    );
    const roleStore = new RoleStore(userDataDir);
    await roleStore.createRole({ gameId: "game-2", name: "Same" });
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-cross-game",
      gameStore: { getGame: async () => game },
      platform: "darwin",
      roleStore,
      showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
      userDataDir
    });

    await manager.previewImport();
    await manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-cross-game",
      profileIds: ["Default"]
    });

    await expect(roleStore.listRoles()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gameId: "game-1", name: "Same" }),
        expect.objectContaining({ gameId: "game-2", name: "Same" })
      ])
    );
  });

  it("rejects duplicate target role names before changing browser data", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default"), { recursive: true });
    await writeFile(
      join(source, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Same" } } } }),
      "utf8"
    );
    const initialStore = new RoleStore(userDataDir);
    const firstRole = await initialStore.createRole({ gameId: game.id, name: "Same" });
    const rolesPath = join(userDataDir, "roles.json");
    const stored = JSON.parse(await readFile(rolesPath, "utf8")) as { roles: Array<Record<string, unknown>> };
    stored.roles.push({ ...firstRole, id: "role-duplicate" });
    await writeFile(rolesPath, `${JSON.stringify(stored)}\n`, "utf8");

    const roleStore = new RoleStore(userDataDir);
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-target-conflict",
      gameStore: { getGame: async () => game },
      platform: "darwin",
      roleStore,
      showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
      userDataDir
    });

    await manager.previewImport();
    await expect(manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-target-conflict",
      profileIds: ["Default"]
    })).rejects.toMatchObject({ code: "ROLE_NAME_CONFLICT" });
    await expect(roleStore.listRoles()).resolves.toHaveLength(2);
    await expect(access(join(userDataDir, ".chrome-profile-import"))).rejects.toMatchObject({ code: "ENOENT" });
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
      replaceRolesForImport: roleStore.replaceRolesForImport.bind(roleStore),
      updateAuthState: async () => {
        throw new Error("simulated auth state failure");
      },
      updateRole: roleStore.updateRole.bind(roleStore)
    };
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-3",
      gameStore: { getGame: async () => game },
      platform: "darwin",
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
    })).rejects.toThrow("simulated auth state failure");
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

  it("restores an overwritten role and its browser data when the import fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-import-"));
    const source = join(root, "Chrome User Data");
    const userDataDir = join(root, "rion-data");
    await mkdir(join(source, "Default"), { recursive: true });
    await writeFile(
      join(source, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Primary" } } } }),
      "utf8"
    );
    await writeFile(join(source, "Default", "Preferences"), "imported", "utf8");
    const roleStore = new RoleStore(userDataDir);
    const existingRole = await roleStore.createRole({ gameId: game.id, name: "Primary", notes: "Original" });
    await roleStore.updateAuthState(existingRole.id, "authenticated", "2020-01-01T00:00:00.000Z");
    await writeFile(
      join(roleStore.getRolePaths(existingRole.id).browserUserDataDir, "original.txt"),
      "keep",
      "utf8"
    );
    let updateRoleCalls = 0;
    const failingRoleStore = {
      createRole: roleStore.createRole.bind(roleStore),
      deleteRole: roleStore.deleteRole.bind(roleStore),
      getRolePaths: roleStore.getRolePaths.bind(roleStore),
      listRoles: roleStore.listRoles.bind(roleStore),
      replaceRolesForImport: roleStore.replaceRolesForImport.bind(roleStore),
      updateAuthState: roleStore.updateAuthState.bind(roleStore),
      updateRole: async (id: string, input: Parameters<RoleStore["updateRole"]>[1]) => {
        updateRoleCalls += 1;
        if (updateRoleCalls === 1) {
          throw new Error("simulated overwrite failure");
        }
        return roleStore.updateRole(id, input);
      }
    };
    const manager = new ChromeProfileImportManager({
      createImportId: () => "import-overwrite-failure",
      gameStore: { getGame: async () => game },
      platform: "darwin",
      roleStore: failingRoleStore,
      showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
      userDataDir
    });

    await manager.previewImport();
    await expect(manager.applyImport({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-overwrite-failure",
      profileIds: ["Default"]
    })).rejects.toThrow("simulated overwrite failure");
    await expect(roleStore.getRole(existingRole.id)).resolves.toMatchObject({
      id: existingRole.id,
      name: "Primary",
      notes: "Original",
      authState: "authenticated",
      lastSuccessfulLoginAt: "2020-01-01T00:00:00.000Z"
    });
    await expect(readFile(join(roleStore.getRolePaths(existingRole.id).browserUserDataDir, "original.txt"), "utf8"))
      .resolves.toBe("keep");
    await expect(access(join(roleStore.getRolePaths(existingRole.id).browserUserDataDir, "Default", "Preferences")))
      .rejects.toMatchObject({ code: "ENOENT" });
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
