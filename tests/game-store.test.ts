import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { GameStore } from "../src/main/games/GameStore";
import { RoleStore } from "../src/main/roles/RoleStore";
import { MemoryStateRepository } from "./helpers/memoryStateRepository";

describe("GameStore Rust adapter", () => {
  let store: GameStore;

  beforeEach(async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-game-adapter-"));
    const repository = new MemoryStateRepository();
    const roles = new RoleStore(baseDir, repository, {
      invoke: async () => ({ browserUserDataDir: join(baseDir, "roles", "unused", "browser") })
    } as never);
    store = new GameStore(baseDir, roles, repository);
  });

  it("lists generated-domain games and delegates CRUD", async () => {
    expect(await store.listGames()).toHaveLength(2);
    const created = await store.createGame({
      name: "Custom",
      defaultLaunchUrl: "https://example.test/play"
    });
    await expect(store.getGame(created.id)).resolves.toMatchObject({ name: "Custom" });
    await expect(store.updateGame(created.id, { name: "Updated" })).resolves.toMatchObject({
      name: "Updated"
    });
    await store.deleteGame(created.id);
    expect((await store.listGames()).some((game) => game.id === created.id)).toBe(false);
  });
});
