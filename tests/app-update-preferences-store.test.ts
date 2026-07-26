import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { AppUpdatePreferencesStore } from "../src/main/updates/AppUpdatePreferencesStore";

describe("AppUpdatePreferencesStore", () => {
  it("defaults to enabled when preference file is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rion-update-prefs-"));
    const store = new AppUpdatePreferencesStore(tempDir);
    try {
      await expect(store.getAutoUpdateEnabled()).resolves.toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("persists and normalizes preference values", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rion-update-prefs-"));
    const store = new AppUpdatePreferencesStore(tempDir);
    try {
      await store.setAutoUpdateEnabled(false);
      await expect(store.getAutoUpdateEnabled()).resolves.toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to enabled for invalid persisted data", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rion-update-prefs-"));
    const preferencesPath = join(tempDir, "app-update-preferences.json");
    await writeFile(preferencesPath, "{ invalid json ");
    try {
      const store = new AppUpdatePreferencesStore(tempDir);
      await expect(store.getAutoUpdateEnabled()).resolves.toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
