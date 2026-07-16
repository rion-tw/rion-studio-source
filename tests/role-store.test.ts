import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it } from "vitest";

import { RoleStore, RoleStoreError } from "../src/main/roles/RoleStore";
import {
  DEFAULT_LAUNCH_URL,
  DEFAULT_ROLE_WINDOW_HEIGHT,
  DEFAULT_ROLE_WINDOW_WIDTH
} from "../src/shared/types";

const sampleCoverImageDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const nextCoverImageDataUrl =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QE//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QE//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QE//Z";
const sampleCoverImageDominantColor = "#1A8CFF";
const nextCoverImageDominantColor = "#00FFAA";
const legacyRolesField = "profile" + "s";

describe("RoleStore", () => {
  let store: RoleStore;
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-studio-test-"));
    store = new RoleStore(baseDir);
  });

  it("creates a role with defaults and a browser role directory", async () => {
    const role = await store.createRole({ gameId: "game-1", name: "Main" });

    expect(role).toMatchObject({
      name: "Main",
      launchUrl: DEFAULT_LAUNCH_URL,
      windowWidth: DEFAULT_ROLE_WINDOW_WIDTH,
      windowHeight: DEFAULT_ROLE_WINDOW_HEIGHT,
      authState: "login_required"
    });
    await expect(mkdir(store.getRolePaths(role.id).browserUserDataDir)).rejects.toMatchObject({
      code: "EEXIST"
    });
  });

  it("removes legacy launch presets without changing timestamps", async () => {
    const role = await store.createRole({ gameId: "game-1", name: "Legacy" });
    const rolesPath = join(baseDir, "roles.json");
    const file = JSON.parse(await readFile(rolesPath, "utf8")) as { roles: Array<Record<string, unknown>> };
    file.roles[0].launchPreset = "performance";
    await writeFile(rolesPath, JSON.stringify(file), "utf8");

    await expect(new RoleStore(baseDir).removeLegacyLaunchPresets()).resolves.toBe(true);
    await expect(new RoleStore(baseDir).listRoles()).resolves.toEqual([role]);
    await expect(readFile(rolesPath, "utf8")).resolves.not.toContain("launchPreset");
  });

  it("ignores and removes an invalid stored launch preset", async () => {
    const role = await store.createRole({ gameId: "game-1", name: "Invalid stored preset" });
    const rolesPath = join(baseDir, "roles.json");
    const file = JSON.parse(await readFile(rolesPath, "utf8")) as { roles: Array<Record<string, unknown>> };
    file.roles[0].launchPreset = "turbo";
    await writeFile(rolesPath, JSON.stringify(file), "utf8");
    const reloadedStore = new RoleStore(baseDir);

    await expect(reloadedStore.listRoles()).resolves.toEqual([role]);
    await reloadedStore.removeLegacyLaunchPresets();
    await expect(readFile(rolesPath, "utf8")).resolves.not.toContain("launchPreset");
  });

  it("returns isolated role copies from the in-memory cache", async () => {
    const role = await store.createRole({ gameId: "game-1", name: "Main" });
    const listed = await store.listRoles();
    listed[0].name = "Mutated by caller";

    await expect(store.getRole(role.id)).resolves.toMatchObject({ name: "Main" });
  });

  it("serializes concurrent deletions without restoring either role", async () => {
    const first = await store.createRole({ gameId: "game-1", name: "First" });
    const second = await store.createRole({ gameId: "game-1", name: "Second" });
    const remaining = await store.createRole({ gameId: "game-1", name: "Remaining" });

    await expect(Promise.all([store.deleteRole(first.id), store.deleteRole(second.id)])).resolves.toEqual([
      undefined,
      undefined
    ]);
    await expect(store.listRoles()).resolves.toEqual([remaining]);
  });

  it("reorders roles atomically without changing timestamps and keeps new roles last", async () => {
    const first = await store.createRole({ gameId: "game-1", name: "First" });
    const second = await store.createRole({ gameId: "game-1", name: "Second" });
    const third = await store.createRole({ gameId: "game-1", name: "Third" });

    const reordered = await store.reorderRoles({ orderedIds: [third.id, first.id, second.id] });

    expect(reordered.map((role) => role.id)).toEqual([third.id, first.id, second.id]);
    expect(reordered.map((role) => role.updatedAt)).toEqual([third.updatedAt, first.updatedAt, second.updatedAt]);
    await expect(new RoleStore(baseDir).listRoles()).resolves.toEqual(reordered);

    const fourth = await store.createRole({ gameId: "game-1", name: "Fourth" });
    await expect(store.listRoles()).resolves.toEqual([...reordered, fourth]);
  });

  it("rejects incomplete, duplicate, and unknown role orders without changing the file", async () => {
    const first = await store.createRole({ gameId: "game-1", name: "First" });
    const second = await store.createRole({ gameId: "game-1", name: "Second" });
    const path = join(baseDir, "roles.json");
    const unchanged = await readFile(path, "utf8");

    for (const orderedIds of [[first.id], [first.id, first.id], [first.id, "unknown"]]) {
      await expect(store.reorderRoles({ orderedIds })).rejects.toMatchObject({ code: "ROLE_ORDER_INVALID" });
      await expect(readFile(path, "utf8")).resolves.toBe(unchanged);
    }

    await expect(store.listRoles()).resolves.toEqual([first, second]);
  });

  it("stores launch URLs when creating or updating roles", async () => {
    const createInput = { gameId: "game-1", name: "Main", launchUrl: "https://example.com/play" };
    const role = await store.createRole(createInput);

    expect(role.launchUrl).toBe("https://example.com/play");

    const updateInput = { notes: "Changed", launchUrl: "https://example.org/play" };
    const updated = await store.updateRole(role.id, updateInput);

    expect(updated).toMatchObject({
      launchUrl: "https://example.org/play",
      notes: "Changed"
    });
  });

  it("resets login state when the launch URL changes", async () => {
    const role = await store.createRole({ gameId: "game-1", name: "Main", launchUrl: "https://example.com/play" });
    await store.updateAuthState(role.id, "authenticated", "2026-07-10T01:00:00.000Z");

    const updated = await store.updateRole(role.id, { launchUrl: "https://example.org/play" });

    expect(updated).toMatchObject({
      launchUrl: "https://example.org/play",
      authState: "login_required"
    });
    expect(updated.lastSuccessfulLoginAt).toBeUndefined();
  });

  it("updates auth state and records auth timestamps", async () => {
    const role = await store.createRole({ gameId: "game-1", name: "Main" });
    const updated = await store.updateAuthState(role.id, "authenticated", "2026-07-10T01:00:00.000Z");

    expect(updated).toMatchObject({
      id: role.id,
      authState: "authenticated",
      lastAuthCheckAt: "2026-07-10T01:00:00.000Z",
      lastSuccessfulLoginAt: "2026-07-10T01:00:00.000Z"
    });
  });

  it("drops legacy login provider fields from stored roles", async () => {
    await writeFile(
      join(baseDir, "roles.json"),
      JSON.stringify({
        roles: [
          {
            id: "role-1",
            name: "Legacy",
            launchUrl: "https://example.com/play",
            windowWidth: 1280,
            windowHeight: 720,
            notes: "",
            launchPreset: "performance",
            authState: "authenticated",
            loginProvider: "google",
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          }
        ]
      }),
      "utf8"
    );

    const role = await store.getRole("role-1");

    expect(role).toMatchObject({
      id: "role-1",
      launchUrl: "https://example.com/play"
    });
    expect(role).not.toHaveProperty("loginProvider");
  });

  it("migrates legacy runtime URL fields to launch URLs", async () => {
    await writeFile(
      join(baseDir, "roles.json"),
      JSON.stringify({
        roles: [
          {
            id: "role-1",
            name: "Legacy",
            gameUrl: "https://legacy.example/play",
            windowWidth: 1280,
            windowHeight: 720,
            notes: "",
            launchPreset: "performance",
            authState: "authenticated",
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          }
        ]
      }),
      "utf8"
    );

    await expect(store.getRole("role-1")).resolves.toMatchObject({
      id: "role-1",
      launchUrl: "https://legacy.example/play"
    });
  });

  it("migrates legacy role metadata and browser data to the new paths", async () => {
    await mkdir(join(baseDir, "profiles", "role-1", "browser"), { recursive: true });
    await writeFile(join(baseDir, "profiles", "role-1", "browser", "session.txt"), "ok", "utf8");
    await writeFile(
      join(baseDir, "profiles.json"),
      JSON.stringify({
        [legacyRolesField]: [
          {
            id: "role-1",
            name: "Legacy",
            launchUrl: "https://example.com/play",
            windowWidth: 1280,
            windowHeight: 720,
            notes: "",
            launchPreset: "performance",
            authState: "authenticated",
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          }
        ]
      }),
      "utf8"
    );

    await expect(store.getRole("role-1")).resolves.toMatchObject({
      id: "role-1",
      name: "Legacy"
    });

    const stored = JSON.parse(await readFile(join(baseDir, "roles.json"), "utf8")) as {
      roles: Array<{ id: string }>;
    };
    expect(stored.roles).toEqual([expect.objectContaining({ id: "role-1" })]);
    await expect(access(join(baseDir, "roles", "role-1", "browser", "session.txt"))).resolves.toBeUndefined();
    await expect(access(join(baseDir, "profiles", "role-1", "browser", "session.txt"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("preserves existing role browser data when migrating legacy directory collisions", async () => {
    await mkdir(join(baseDir, "roles", "role-1", "browser"), { recursive: true });
    await writeFile(join(baseDir, "roles", "role-1", "browser", "current.txt"), "current", "utf8");
    await mkdir(join(baseDir, "profiles", "role-1", "browser"), { recursive: true });
    await mkdir(join(baseDir, "profiles", "role-2", "browser"), { recursive: true });
    await writeFile(join(baseDir, "profiles", "role-1", "browser", "legacy.txt"), "legacy", "utf8");
    await writeFile(join(baseDir, "profiles", "role-2", "browser", "legacy.txt"), "legacy", "utf8");
    await writeFile(
      join(baseDir, "profiles.json"),
      JSON.stringify({
        [legacyRolesField]: [
          {
            id: "role-1",
            name: "Current",
            launchUrl: "https://example.com/current",
            windowWidth: 1280,
            windowHeight: 720,
            notes: "",
            launchPreset: "performance",
            authState: "authenticated",
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          },
          {
            id: "role-2",
            name: "Legacy",
            launchUrl: "https://example.com/legacy",
            windowWidth: 1280,
            windowHeight: 720,
            notes: "",
            launchPreset: "performance",
            authState: "authenticated",
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          }
        ]
      }),
      "utf8"
    );

    await store.listRoles();

    await expect(access(join(baseDir, "roles", "role-1", "browser", "current.txt"))).resolves.toBeUndefined();
    await expect(access(join(baseDir, "roles", "role-1", "browser", "legacy.txt"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(join(baseDir, "profiles", "role-1", "browser", "legacy.txt"))).resolves.toBeUndefined();
    await expect(access(join(baseDir, "roles", "role-2", "browser", "legacy.txt"))).resolves.toBeUndefined();
  });

  it("rejects duplicate names case-insensitively", async () => {
    await store.createRole({ gameId: "game-1", name: "Main" });

    await expect(store.createRole({ gameId: "game-1", name: "main" })).rejects.toBeInstanceOf(RoleStoreError);
    await expect(store.createRole({ gameId: "game-1", name: "main" })).rejects.toMatchObject({
      code: "ROLE_NAME_DUPLICATE"
    });
  });

  it("allows the same role name in different games", async () => {
    const first = await store.createRole({ gameId: "game-1", name: "Main" });
    const second = await store.createRole({ gameId: "game-2", name: "main" });

    expect(first.gameId).toBe("game-1");
    expect(second).toMatchObject({ gameId: "game-2", name: "main" });
    await expect(store.updateRole(second.id, { gameId: "game-1" })).rejects.toMatchObject({
      code: "ROLE_NAME_DUPLICATE"
    });
  });

  it("updates a role and keeps its original created timestamp", async () => {
    const role = await store.createRole({ gameId: "game-1", name: "Main" });
    const updated = await store.updateRole(role.id, {
      name: "Main 2",
      windowWidth: 1440,
      windowHeight: 900
    });

    expect(updated).toMatchObject({
      id: role.id,
      name: "Main 2",
      windowWidth: 1440,
      windowHeight: 900,
      createdAt: role.createdAt
    });
    expect(updated.updatedAt >= role.updatedAt).toBe(true);
  });

  it("creates a role with an optional cover image", async () => {
    const role = await store.createRole({
      gameId: "game-1",
      name: "Main",
      coverImageDataUrl: sampleCoverImageDataUrl,
      coverImageDominantColor: sampleCoverImageDominantColor.toLowerCase()
    });

    expect(role.coverImageDataUrl).toBe(sampleCoverImageDataUrl);
    expect(role.coverImageDominantColor).toBe(sampleCoverImageDominantColor);
    await expect(store.getRole(role.id)).resolves.toMatchObject({
      coverImageDataUrl: sampleCoverImageDataUrl,
      coverImageDominantColor: sampleCoverImageDominantColor
    });
  });

  it("updates and clears a role cover image", async () => {
    const role = await store.createRole({
      gameId: "game-1",
      name: "Main",
      coverImageDataUrl: sampleCoverImageDataUrl,
      coverImageDominantColor: sampleCoverImageDominantColor
    });

    const updated = await store.updateRole(role.id, {
      coverImageDataUrl: nextCoverImageDataUrl,
      coverImageDominantColor: nextCoverImageDominantColor.toLowerCase()
    });
    expect(updated.coverImageDataUrl).toBe(nextCoverImageDataUrl);
    expect(updated.coverImageDominantColor).toBe(nextCoverImageDominantColor);

    const unchanged = await store.updateRole(role.id, {
      notes: "No cover change"
    });
    expect(unchanged.coverImageDataUrl).toBe(nextCoverImageDataUrl);
    expect(unchanged.coverImageDominantColor).toBe(nextCoverImageDominantColor);

    const replacedWithoutColor = await store.updateRole(role.id, {
      coverImageDataUrl: sampleCoverImageDataUrl
    });
    expect(replacedWithoutColor.coverImageDataUrl).toBe(sampleCoverImageDataUrl);
    expect(replacedWithoutColor.coverImageDominantColor).toBeUndefined();

    const cleared = await store.updateRole(role.id, {
      coverImageDataUrl: null,
      coverImageDominantColor: sampleCoverImageDominantColor
    });
    expect(cleared.coverImageDataUrl).toBeUndefined();
    expect(cleared.coverImageDominantColor).toBeUndefined();
  });

  it("keeps cover image optional", async () => {
    const role = await store.createRole({ gameId: "game-1", name: "Main" });

    expect(role.coverImageDataUrl).toBeUndefined();
    await expect(store.getRole(role.id)).resolves.toMatchObject({
      id: role.id
    });
  });

  it("rejects invalid or oversized cover image data URLs", async () => {
    await expect(
      store.createRole({
        gameId: "game-1",
        name: "Main",
        coverImageDataUrl: "data:text/plain;base64,SGVsbG8="
      })
    ).rejects.toMatchObject({
      code: "ROLE_COVER_IMAGE_INVALID"
    });

    await expect(
      store.createRole({
        gameId: "game-1",
        name: "Main 2",
        coverImageDataUrl: `data:image/png;base64,${"A".repeat(1_500_001)}`
      })
    ).rejects.toMatchObject({
      code: "ROLE_COVER_IMAGE_INVALID"
    });
  });

  it("rejects invalid launch URLs", async () => {
    await expect(store.createRole({ gameId: "game-1", name: "Main", launchUrl: "notaurl" })).rejects.toMatchObject({
      code: "ROLE_LAUNCH_URL_INVALID"
    });
    await expect(store.createRole({ gameId: "game-1", name: "Main 2", launchUrl: "file:///tmp/app" })).rejects.toMatchObject({
      code: "ROLE_LAUNCH_URL_INVALID"
    });
    const role = await store.createRole({ gameId: "game-1", name: "Main 3" });

    await expect(store.updateRole(role.id, { launchUrl: "" })).rejects.toMatchObject({
      code: "ROLE_LAUNCH_URL_INVALID"
    });
  });

  it("rejects invalid cover image dominant colors", async () => {
    await expect(
      store.createRole({
        gameId: "game-1",
        name: "Main",
        coverImageDataUrl: sampleCoverImageDataUrl,
        coverImageDominantColor: "1A8CFF"
      })
    ).rejects.toMatchObject({
      code: "ROLE_COVER_COLOR_INVALID"
    });

    const role = await store.createRole({ gameId: "game-1", name: "Main 2" });

    await expect(
      store.updateRole(role.id, {
        coverImageDominantColor: "#XYZ123"
      })
    ).rejects.toMatchObject({
      code: "ROLE_COVER_COLOR_INVALID"
    });
  });

  it("reads legacy cover images without a dominant color", async () => {
    await writeFile(
      join(baseDir, "roles.json"),
      JSON.stringify({
        roles: [
          {
            id: "role-1",
            name: "Legacy Cover",
            launchUrl: "https://example.com/play",
            windowWidth: 1280,
            windowHeight: 720,
            notes: "",
            launchPreset: "performance",
            authState: "authenticated",
            coverImageDataUrl: sampleCoverImageDataUrl,
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          }
        ]
      }),
      "utf8"
    );

    const role = await store.getRole("role-1");

    expect(role.coverImageDataUrl).toBe(sampleCoverImageDataUrl);
    expect(role.coverImageDominantColor).toBeUndefined();
  });

  it("deletes metadata and browser session data", async () => {
    const role = await store.createRole({ gameId: "game-1", name: "Main" });

    await store.deleteRole(role.id);

    await expect(store.getRole(role.id)).rejects.toMatchObject({
      code: "ROLE_NOT_FOUND"
    });
    await expect(access(store.getRolePaths(role.id).browserUserDataDir)).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(store.ensureBrowserUserDataDir(role.id)).rejects.toMatchObject({
      code: "ROLE_NOT_FOUND"
    });
    await expect(access(store.getRolePaths(role.id).browserUserDataDir)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
