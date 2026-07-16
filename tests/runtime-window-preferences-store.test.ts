import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RUNTIME_WINDOW_PREFERENCES,
  RuntimeWindowPreferencesStore
} from "../src/main/window/RuntimeWindowPreferencesStore";

describe("RuntimeWindowPreferencesStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-runtime-window-preferences-"));
  });

  it("normalizes missing, invalid, and partial preferences", async () => {
    const missingStore = new RuntimeWindowPreferencesStore(baseDir);
    await expect(missingStore.getPreferences()).resolves.toEqual(
      DEFAULT_RUNTIME_WINDOW_PREFERENCES
    );

    await writeFile(
      join(baseDir, "runtime-window-preferences.json"),
      JSON.stringify({ alwaysShowToolbarInFullScreen: "yes", ignored: true }),
      "utf8"
    );
    const invalidStore = new RuntimeWindowPreferencesStore(baseDir);
    await expect(invalidStore.getPreferences()).resolves.toEqual(
      DEFAULT_RUNTIME_WINDOW_PREFERENCES
    );
  });

  it("atomically saves and reloads the fullscreen toolbar preference", async () => {
    const store = new RuntimeWindowPreferencesStore(baseDir);
    await expect(store.updatePreferences({ alwaysShowToolbarInFullScreen: true })).resolves.toEqual({
      alwaysShowToolbarInFullScreen: true
    });

    await expect(
      readFile(join(baseDir, "runtime-window-preferences.json.tmp"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      new RuntimeWindowPreferencesStore(baseDir).getPreferences()
    ).resolves.toEqual({ alwaysShowToolbarInFullScreen: true });
  });
});
