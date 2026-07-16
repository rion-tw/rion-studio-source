import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_ACTIVITY_MIGRATION_FILE,
  BACKGROUND_ACTIVITY_MIGRATION_VERSION,
  runBackgroundActivityMigration
} from "../src/main/persistence/BackgroundActivityMigration";

describe("background activity migration", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-studio-background-activity-test-"));
  });

  it("runs both stores once and records completion atomically", async () => {
    const roleStore = { removeLegacyLaunchPresets: vi.fn().mockResolvedValue(true) };
    const gameStore = { removeLegacyLaunchPresets: vi.fn().mockResolvedValue(true) };

    await expect(runBackgroundActivityMigration(baseDir, { gameStore, roleStore })).resolves.toBe(true);
    await expect(runBackgroundActivityMigration(baseDir, { gameStore, roleStore })).resolves.toBe(false);

    expect(roleStore.removeLegacyLaunchPresets).toHaveBeenCalledTimes(1);
    expect(gameStore.removeLegacyLaunchPresets).toHaveBeenCalledTimes(1);
    await expect(readFile(join(baseDir, BACKGROUND_ACTIVITY_MIGRATION_FILE), "utf8"))
      .resolves.toContain(`"version": ${BACKGROUND_ACTIVITY_MIGRATION_VERSION}`);
  });

  it("does not mark an interrupted migration and retries it safely", async () => {
    const roleStore = { removeLegacyLaunchPresets: vi.fn().mockResolvedValue(true) };
    const gameStore = {
      removeLegacyLaunchPresets: vi.fn()
        .mockRejectedValueOnce(new Error("simulated interruption"))
        .mockResolvedValueOnce(true)
    };
    const markerPath = join(baseDir, BACKGROUND_ACTIVITY_MIGRATION_FILE);

    await expect(runBackgroundActivityMigration(baseDir, { gameStore, roleStore }))
      .rejects.toThrow("simulated interruption");
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(runBackgroundActivityMigration(baseDir, { gameStore, roleStore })).resolves.toBe(true);
    expect(roleStore.removeLegacyLaunchPresets).toHaveBeenCalledTimes(2);
    expect(gameStore.removeLegacyLaunchPresets).toHaveBeenCalledTimes(2);
  });
});
