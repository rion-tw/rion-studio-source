import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { GameStore } from "../src/main/games/GameStore";
import { RoleStore } from "../src/main/roles/RoleStore";
import { FEIFEI_INFINITE_UNIVERSE_GAME_ID, FLYFF_UNIVERSE_GAME_ID } from "../src/shared/games";

describe("GameStore", () => {
  let baseDir: string;
  let roleStore: RoleStore;
  let store: GameStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-studio-games-test-"));
    roleStore = new RoleStore(baseDir);
    store = new GameStore(baseDir, roleStore);
  });

  it("seeds stable built-in games and repairs protected fields", async () => {
    await store.initialize();
    const games = await store.listGames();

    expect(games.map((game) => game.id)).toEqual([
      FLYFF_UNIVERSE_GAME_ID,
      FEIFEI_INFINITE_UNIVERSE_GAME_ID
    ]);
    expect(games.every((game) => game.source === "builtin")).toBe(true);

    const flyff = games[0];
    await writeFile(join(baseDir, "games.json"), JSON.stringify({ games: [{
      ...flyff,
      id: "tampered",
      name: "Tampered",
      iconImageDataUrl: "data:image/png;base64,QQ==",
      coverImageDataUrl: "data:image/webp;base64,QQ=="
    }, games[1]] }), "utf8");

    const repaired = await new GameStore(baseDir, roleStore).listGames();
    expect(repaired[0]).toMatchObject({
      id: FLYFF_UNIVERSE_GAME_ID,
      name: "Flyff Universe",
      source: "builtin"
    });
    expect(repaired[0].iconImageDataUrl).toBeUndefined();
    expect(repaired[0].coverImageDataUrl).toBeUndefined();
  });

  it("migrates custom role defaults to balanced without changing game timestamps", async () => {
    await store.initialize();
    const game = await store.createGame({
      name: "Performance defaults",
      defaultLaunchUrl: "https://example.test/performance",
      roleDefaults: { windowWidth: 1280, windowHeight: 720, launchPreset: "performance" }
    });

    await expect(store.migrateLaunchPresetsToBalanced()).resolves.toBe(true);
    await expect(store.getGame(game.id)).resolves.toEqual({
      ...game,
      roleDefaults: { windowWidth: 1280, windowHeight: 720, launchPreset: "balanced" }
    });
    await expect(store.migrateLaunchPresetsToBalanced()).resolves.toBe(false);
  });

  it("normalizes an invalid stored game launch preset to balanced during migration", async () => {
    await store.initialize();
    const game = await store.createGame({
      name: "Invalid stored defaults",
      defaultLaunchUrl: "https://example.test/invalid",
      roleDefaults: { windowWidth: 1280, windowHeight: 720, launchPreset: "performance" }
    });
    const gamesPath = join(baseDir, "games.json");
    const file = JSON.parse(await readFile(gamesPath, "utf8")) as { games: Array<Record<string, unknown>> };
    const storedGame = file.games.find((item) => item.id === game.id);
    (storedGame?.roleDefaults as Record<string, unknown>).launchPreset = "turbo";
    await writeFile(gamesPath, JSON.stringify(file), "utf8");
    const reloadedStore = new GameStore(baseDir, roleStore);

    await expect(reloadedStore.getGame(game.id)).resolves.toEqual({
      ...game,
      roleDefaults: { windowWidth: 1280, windowHeight: 720, launchPreset: "balanced" }
    });
    await reloadedStore.migrateLaunchPresetsToBalanced();
    await expect(readFile(gamesPath, "utf8")).resolves.toContain('"launchPreset": "balanced"');
  });

  it("migrates known and unknown role URLs idempotently without changing role metadata", async () => {
    const known = await roleStore.createRole({
      gameId: "legacy-missing",
      name: "Known",
      launchUrl: "https://universe.flyff.com/play"
    });
    const unknown = await roleStore.createRole({
      gameId: "legacy-missing",
      name: "Unknown",
      launchUrl: "https://example.test/game"
    });
    await roleStore.updateAuthState(known.id, "authenticated", "2026-07-10T01:00:00.000Z");
    const before = await roleStore.getRole(known.id);

    await store.initialize();
    const firstGames = await store.listGames();
    await store.initialize();
    const secondGames = await store.listGames();
    const migratedKnown = await roleStore.getRole(known.id);
    const migratedUnknown = await roleStore.getRole(unknown.id);

    expect(migratedKnown.gameId).toBe(FLYFF_UNIVERSE_GAME_ID);
    expect(migratedUnknown.gameId).toBe(firstGames.find((game) => game.defaultLaunchUrl === "https://example.test/game")?.id);
    expect(secondGames).toEqual(firstGames);
    expect(migratedKnown).toMatchObject({
      id: before.id,
      authState: before.authState,
      createdAt: before.createdAt,
      updatedAt: before.updatedAt,
      lastSuccessfulLoginAt: before.lastSuccessfulLoginAt
    });
  });

  it("reuses one recovered game for roles with the same normalized URL", async () => {
    await roleStore.createRole({ gameId: "legacy-missing", name: "One", launchUrl: "https://example.test/game" });
    await roleStore.createRole({ gameId: "legacy-missing", name: "Two", launchUrl: "https://example.test/game" });
    await store.initialize();

    const roles = await roleStore.listRoles();
    expect(roles[0].gameId).toBe(roles[1].gameId);
    expect((await store.listGames()).filter((game) => game.source === "custom")).toHaveLength(1);
  });

  it("resumes an interrupted migration without duplicating recovered games", async () => {
    const role = await roleStore.createRole({
      gameId: "legacy-missing",
      name: "Interrupted",
      launchUrl: "https://example.test/game?server=one"
    });
    const interruptedStore = new GameStore(baseDir, {
      listRoles: () => roleStore.listRoles(),
      assignGameIds: async () => { throw new Error("simulated interruption"); }
    });

    await expect(interruptedStore.initialize()).rejects.toThrow("simulated interruption");
    expect((await interruptedStore.listGames()).filter((game) => game.source === "custom")).toHaveLength(1);

    await store.initialize();
    expect((await store.listGames()).filter((game) => game.source === "custom")).toHaveLength(1);
    expect((await roleStore.getRole(role.id)).gameId).not.toBe("legacy-missing");
  });

  it("creates unique names for different URLs that share a hostname and path", async () => {
    await roleStore.createRole({ gameId: "legacy-missing", name: "One", launchUrl: "https://same.test/play?server=one" });
    await roleStore.createRole({ gameId: "legacy-missing", name: "Two", launchUrl: "https://same.test/play?server=two" });
    await store.initialize();

    const customNames = (await store.listGames()).filter((game) => game.source === "custom").map((game) => game.name);
    expect(customNames).toEqual(["same.test", "same.test 2"]);
  });

  it("validates unique names, URLs, icons, and complete role defaults", async () => {
    await store.initialize();
    await store.createGame({ name: "Custom", defaultLaunchUrl: "https://example.test" });

    await expect(store.createGame({ name: "custom", defaultLaunchUrl: "https://other.test" }))
      .rejects.toMatchObject({ code: "GAME_NAME_DUPLICATE" });
    await expect(store.createGame({ name: "Bad URL", defaultLaunchUrl: "file:///tmp/game" }))
      .rejects.toMatchObject({ code: "GAME_URL_INVALID" });
    await expect(store.createGame({ name: "Bad mode", defaultLaunchUrl: "https://mode.test", browserLaunchMode: "invalid" as never }))
      .rejects.toMatchObject({ code: "GAME_LAUNCH_MODE_INVALID" });
    await expect(store.createGame({ name: "Bad icon", defaultLaunchUrl: "https://icon.test", iconImageDataUrl: "data:text/plain;base64,QQ==" }))
      .rejects.toMatchObject({ code: "GAME_ICON_INVALID" });
    await expect(store.createGame({ name: "Bad cover", defaultLaunchUrl: "https://cover.test", coverImageDataUrl: "data:text/plain;base64,QQ==" }))
      .rejects.toMatchObject({ code: "GAME_COVER_INVALID" });
    const validLargeIcon = `data:image/png;base64,${Buffer.alloc(1_200_000).toString("base64")}`;
    await expect(store.createGame({ name: "Large icon", defaultLaunchUrl: "https://large-icon.test", iconImageDataUrl: validLargeIcon }))
      .resolves.toMatchObject({ iconImageDataUrl: validLargeIcon });
    const oversizedIcon = `data:image/png;base64,${Buffer.alloc(1_500_001).toString("base64")}`;
    await expect(store.createGame({ name: "Oversized icon", defaultLaunchUrl: "https://oversized-icon.test", iconImageDataUrl: oversizedIcon }))
      .rejects.toMatchObject({ code: "GAME_ICON_INVALID" });
    const validCover = `data:image/webp;base64,${Buffer.alloc(1_200_000).toString("base64")}`;
    const gameWithCover = await store.createGame({
      name: "Covered",
      defaultLaunchUrl: "https://covered.test",
      coverImageDataUrl: validCover
    });
    expect(gameWithCover.coverImageDataUrl).toBe(validCover);
    expect(JSON.parse(await readFile(join(baseDir, "games.json"), "utf8")).games
      .find((game: { id: string }) => game.id === gameWithCover.id).coverImageDataUrl).toBe(validCover);
    await expect(store.updateGame(gameWithCover.id, { coverImageDataUrl: null }))
      .resolves.toMatchObject({ coverImageDataUrl: undefined });
    const oversizedCover = `data:image/jpeg;base64,${Buffer.alloc(1_500_001).toString("base64")}`;
    await expect(store.updateGame(gameWithCover.id, { coverImageDataUrl: oversizedCover }))
      .rejects.toMatchObject({ code: "GAME_COVER_INVALID" });
    await expect(store.createGame({
      name: "Bad defaults",
      defaultLaunchUrl: "https://defaults.test",
      roleDefaults: { windowWidth: 100, windowHeight: 900, launchPreset: "performance" }
    })).rejects.toMatchObject({ code: "GAME_ROLE_DEFAULTS_INVALID" });
  });

  it("protects and resets built-in game fields", async () => {
    await store.initialize();
    await expect(store.updateGame(FLYFF_UNIVERSE_GAME_ID, { name: "Renamed" }))
      .rejects.toMatchObject({ code: "GAME_BUILTIN_FIELD_PROTECTED" });
    await expect(store.updateGame(FLYFF_UNIVERSE_GAME_ID, { coverImageDataUrl: null }))
      .rejects.toMatchObject({ code: "GAME_BUILTIN_FIELD_PROTECTED" });
    await expect(store.deleteGame(FLYFF_UNIVERSE_GAME_ID))
      .rejects.toMatchObject({ code: "GAME_BUILTIN_DELETE_FORBIDDEN" });

    await store.updateGame(FLYFF_UNIVERSE_GAME_ID, {
      defaultLaunchUrl: "https://example.test/override",
      browserLaunchMode: "external",
      roleDefaults: { windowWidth: 1280, windowHeight: 720, launchPreset: "balanced" }
    });
    const reset = await store.resetBuiltinGame(FLYFF_UNIVERSE_GAME_ID);
    expect(reset).toMatchObject({
      defaultLaunchUrl: "https://universe.flyff.com/play",
      browserLaunchMode: "inherit"
    });
    expect(reset.roleDefaults).toBeUndefined();
  });

  it("blocks deleting a custom game that still has roles", async () => {
    await store.initialize();
    const game = await store.createGame({ name: "In use", defaultLaunchUrl: "https://example.test" });
    await roleStore.createRole({ gameId: game.id, name: "Assigned" });

    await expect(store.deleteGame(game.id)).rejects.toMatchObject({
      code: "GAME_IN_USE",
      details: { roleCount: 1, roleNames: ["Assigned"] }
    });
    await roleStore.deleteRole((await roleStore.listRoles())[0].id);
    await expect(store.deleteGame(game.id)).resolves.toBeUndefined();
  });

  it("writes game data atomically without leaving temporary files", async () => {
    await store.initialize();
    await store.createGame({ name: "Atomic", defaultLaunchUrl: "https://atomic.test" });
    const raw = await readFile(join(baseDir, "games.json"), "utf8");
    expect(JSON.parse(raw).games).toHaveLength(3);
    expect(raw.endsWith("\n")).toBe(true);
  });
});
