import { describe, expect, it } from "vitest";

import {
  BACKGROUND_ACTIVITY_MIGRATION_STORAGE_KEY,
  DEFAULT_ROLE_DEFAULTS,
  ROLE_DEFAULTS_STORAGE_KEY,
  createEmptyRoleForm,
  normalizeRoleDefaults,
  readStoredRoleDefaults,
  writeStoredRoleDefaults
} from "../src/renderer/src/app/roleDefaults";

describe("renderer role defaults", () => {
  it("reads stored role defaults", () => {
    const storage = createStorage({
      [ROLE_DEFAULTS_STORAGE_KEY]: JSON.stringify({
        windowWidth: 1600,
        windowHeight: 900,
        launchPreset: "balanced"
      })
    });

    expect(readStoredRoleDefaults(storage)).toEqual({
      windowWidth: 1600,
      windowHeight: 900,
      launchPreset: "balanced"
    });
  });

  it("migrates an existing performance default once and preserves later explicit choices", () => {
    const storage = createStorage({
      [ROLE_DEFAULTS_STORAGE_KEY]: JSON.stringify({
        windowWidth: 1920,
        windowHeight: 1080,
        launchPreset: "performance"
      })
    });

    expect(readStoredRoleDefaults(storage)).toEqual({
      windowWidth: 1920,
      windowHeight: 1080,
      launchPreset: "balanced"
    });
    expect(storage.getItem(BACKGROUND_ACTIVITY_MIGRATION_STORAGE_KEY)).toBe("1");

    writeStoredRoleDefaults({
      windowWidth: 1920,
      windowHeight: 1080,
      launchPreset: "performance"
    }, storage);
    expect(readStoredRoleDefaults(storage).launchPreset).toBe("performance");
  });

  it("falls back field-by-field for missing values", () => {
    expect(normalizeRoleDefaults({ windowWidth: 1280 })).toEqual({
      ...DEFAULT_ROLE_DEFAULTS,
      windowWidth: 1280
    });
  });

  it("falls back to defaults for bad JSON", () => {
    const storage = createStorage({
      [ROLE_DEFAULTS_STORAGE_KEY]: "{nope"
    });

    expect(readStoredRoleDefaults(storage)).toEqual(DEFAULT_ROLE_DEFAULTS);
  });

  it("falls back for invalid window sizes and launch presets", () => {
    expect(
      normalizeRoleDefaults({
        windowWidth: 500,
        windowHeight: 7681,
        launchPreset: "turbo"
      })
    ).toEqual(DEFAULT_ROLE_DEFAULTS);
  });

  it("writes normalized role defaults and creates empty role forms from them", () => {
    const storage = createStorage();
    const normalized = writeStoredRoleDefaults(
      {
        windowWidth: 1920,
        windowHeight: 1080,
        launchPreset: "balanced"
      },
      storage
    );

    expect(normalized).toEqual({
      windowWidth: 1920,
      windowHeight: 1080,
      launchPreset: "balanced"
    });
    expect(JSON.parse(storage.getItem(ROLE_DEFAULTS_STORAGE_KEY) ?? "{}")).toEqual(normalized);
    expect(createEmptyRoleForm(normalized)).toMatchObject({
      windowWidth: 1920,
      windowHeight: 1080,
      launchPreset: "balanced"
    });
  });
});

function createStorage(initialValues: Record<string, string> = {}) {
  const values = new Map(Object.entries(initialValues));

  return {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    }
  };
}
