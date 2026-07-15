import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { GameStore } from "../games/GameStore";
import type { RoleStore } from "../roles/RoleStore";
import { writeJsonFileAtomically } from "./atomicJsonFile";

export const BACKGROUND_ACTIVITY_MIGRATION_VERSION = 1;
export const BACKGROUND_ACTIVITY_MIGRATION_FILE = "background-activity-migration.json";

interface BackgroundActivityMigrationStores {
  gameStore: Pick<GameStore, "migrateLaunchPresetsToBalanced">;
  roleStore: Pick<RoleStore, "migrateLaunchPresetsToBalanced">;
}

export async function runBackgroundActivityMigration(
  userDataDir: string,
  stores: BackgroundActivityMigrationStores
): Promise<boolean> {
  const markerPath = join(userDataDir, BACKGROUND_ACTIVITY_MIGRATION_FILE);
  if (await isMigrationComplete(markerPath)) {
    return false;
  }

  await stores.roleStore.migrateLaunchPresetsToBalanced();
  await stores.gameStore.migrateLaunchPresetsToBalanced();
  await writeJsonFileAtomically(markerPath, { version: BACKGROUND_ACTIVITY_MIGRATION_VERSION });
  return true;
}

async function isMigrationComplete(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
    return value.version === BACKGROUND_ACTIVITY_MIGRATION_VERSION;
  } catch (error) {
    if (error instanceof SyntaxError || (isNodeError(error) && error.code === "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
