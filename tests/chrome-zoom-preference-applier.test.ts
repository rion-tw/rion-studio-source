import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  applyChromeZoomFactorToPreferences,
  ChromeZoomPreferenceApplier,
  chromeZoomFactorToLevel
} from "../src/main/browser/ChromeZoomPreferenceApplier";

describe("ChromeZoomPreferenceApplier", () => {
  it.each([0.25, 0.33, 0.5, 0.9, 1, 1.25])(
    "converts zoom factor %s to Chromium's zoom level",
    (zoomFactor) => {
      expect(chromeZoomFactorToLevel(zoomFactor)).toBeCloseTo(
        Math.log(zoomFactor) / Math.log(1.2),
        12
      );
    }
  );

  it("sets the Default partition zoom while preserving unrelated preferences", () => {
    const preferences = {
      partition: {
        default_zoom_level: { other: 2, x: 4 },
        per_host_zoom_levels: {
          other: { "other.example": { zoom_level: 2 } },
          x: { "game.example": { last_modified: "1", zoom_level: 4 } }
        },
        unrelated: true
      },
      profile: { name: "Role profile" }
    };

    expect(applyChromeZoomFactorToPreferences(preferences, 0.5)).toEqual({
      partition: {
        default_zoom_level: {
          other: 2,
          x: chromeZoomFactorToLevel(0.5)
        },
        per_host_zoom_levels: {
          other: { "other.example": { zoom_level: 2 } }
        },
        unrelated: true
      },
      profile: { name: "Role profile" }
    });
    expect(preferences.partition.default_zoom_level.x).toBe(4);
  });

  it("restores 100% by removing Default partition overrides", () => {
    expect(applyChromeZoomFactorToPreferences({
      partition: {
        default_zoom_level: { other: 2, x: -3 },
        per_host_zoom_levels: {
          other: { "other.example": { zoom_level: 2 } },
          x: { "game.example": { zoom_level: -3 } }
        }
      }
    }, 1)).toEqual({
      partition: {
        default_zoom_level: { other: 2 },
        per_host_zoom_levels: {
          other: { "other.example": { zoom_level: 2 } }
        }
      }
    });
  });

  it("writes through a temporary file before atomically renaming it", async () => {
    const makeDirectory = vi.fn().mockResolvedValue(undefined);
    const readTextFile = vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const renameFile = vi.fn().mockResolvedValue(undefined);
    const writeTextFile = vi.fn().mockResolvedValue(undefined);
    const applier = new ChromeZoomPreferenceApplier({
      makeDirectory,
      readTextFile,
      renameFile,
      writeTextFile
    });

    const chromeUserDataDir = "/profiles/role-1/browser";
    await applier.applyToChromeUserDataDir(chromeUserDataDir, 0.75);

    const defaultProfileDirectory = join(chromeUserDataDir, "Default");
    const preferencesPath = join(defaultProfileDirectory, "Preferences");
    expect(makeDirectory).toHaveBeenCalledWith(defaultProfileDirectory, { recursive: true });
    expect(writeTextFile).toHaveBeenCalledWith(
      `${preferencesPath}.tmp`,
      expect.stringContaining(`"x": ${chromeZoomFactorToLevel(0.75)}`),
      "utf8"
    );
    expect(renameFile).toHaveBeenCalledWith(`${preferencesPath}.tmp`, preferencesPath);
    expect(writeTextFile.mock.invocationCallOrder[0]).toBeLessThan(
      renameFile.mock.invocationCallOrder[0]
    );
  });

  it("replaces an invalid preferences document with valid zoom preferences", async () => {
    const writeTextFile = vi.fn().mockResolvedValue(undefined);
    const applier = new ChromeZoomPreferenceApplier({
      makeDirectory: vi.fn().mockResolvedValue(undefined),
      readTextFile: vi.fn().mockResolvedValue("[invalid"),
      renameFile: vi.fn().mockResolvedValue(undefined),
      writeTextFile
    });

    await applier.applyToPreferencesFile("/profiles/role-1/browser/Default/Preferences", 1.25);

    const written = JSON.parse(String(writeTextFile.mock.calls[0][1])) as {
      partition: { default_zoom_level: { x: number } };
    };
    expect(written.partition.default_zoom_level.x).toBeCloseTo(chromeZoomFactorToLevel(1.25), 12);
  });

  it("does not create a missing preferences file when resetting to 100%", async () => {
    const writeTextFile = vi.fn().mockResolvedValue(undefined);
    const applier = new ChromeZoomPreferenceApplier({
      readTextFile: vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" })),
      writeTextFile
    });

    await applier.applyToPreferencesFile("/profiles/role-1/browser/Default/Preferences", 1);

    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("rejects invalid zoom factors", async () => {
    const applier = new ChromeZoomPreferenceApplier();
    await expect(applier.applyToPreferencesFile("/preferences", 0)).rejects.toThrow(
      "Chrome zoom factor must be greater than zero."
    );
  });
});
