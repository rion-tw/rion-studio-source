import { describe, expect, it } from "vitest";

import {
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
      windowHeight: 900
    });
    expect(JSON.parse(storage.getItem(ROLE_DEFAULTS_STORAGE_KEY) ?? "{}")).not.toHaveProperty("launchPreset");
  });

  it("strips a legacy performance default when reading and writing", () => {
    const storage = createStorage({
      [ROLE_DEFAULTS_STORAGE_KEY]: JSON.stringify({
        windowWidth: 1920,
        windowHeight: 1080,
        launchPreset: "performance"
      })
    });

    expect(readStoredRoleDefaults(storage)).toEqual({
      windowWidth: 1920,
      windowHeight: 1080
    });
    expect(JSON.parse(storage.getItem(ROLE_DEFAULTS_STORAGE_KEY) ?? "{}")).not.toHaveProperty("launchPreset");

    writeStoredRoleDefaults({
      windowWidth: 1920,
      windowHeight: 1080
    }, storage);
    expect(readStoredRoleDefaults(storage)).toEqual({ windowWidth: 1920, windowHeight: 1080 });
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

  it("falls back for invalid window sizes", () => {
    expect(
      normalizeRoleDefaults({
        windowWidth: 500,
        windowHeight: 7681
      })
    ).toEqual(DEFAULT_ROLE_DEFAULTS);
  });

  it("writes normalized role defaults and creates empty role forms from them", () => {
    const storage = createStorage();
    const normalized = writeStoredRoleDefaults(
      {
        windowWidth: 1920,
        windowHeight: 1080
      },
      storage
    );

    expect(normalized).toEqual({
      windowWidth: 1920,
      windowHeight: 1080
    });
    expect(JSON.parse(storage.getItem(ROLE_DEFAULTS_STORAGE_KEY) ?? "{}")).toEqual(normalized);
    expect(createEmptyRoleForm(normalized)).toMatchObject({
      windowWidth: 1920,
      windowHeight: 1080
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
