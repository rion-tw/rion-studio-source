import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MacroSettingsStore } from "../src/main/macros/MacroSettingsStore";
import {
  DEFAULT_MACRO_SETTINGS,
  MACRO_DELAY_MAX_MS,
  MACRO_SETTINGS_CONSTRAINTS,
  isValidMacroSettingValue,
  normalizeMacroSettings
} from "../src/shared/macroSettings";

describe("MacroSettingsStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-macro-settings-"));
  });

  afterEach(async () => {
    await rm(baseDir, { force: true, recursive: true });
    baseDir = "";
  });

  it("returns reliable defaults when the file is missing or damaged", async () => {
    await expect(new MacroSettingsStore(baseDir).getSettings()).resolves.toEqual(DEFAULT_MACRO_SETTINGS);

    await writeFile(join(baseDir, "macro-settings.json"), "{broken", "utf8");
    await expect(new MacroSettingsStore(baseDir).getSettings()).resolves.toEqual(DEFAULT_MACRO_SETTINGS);
  });

  it("normalizes invalid persisted fields independently", async () => {
    await writeFile(
      join(baseDir, "macro-settings.json"),
      JSON.stringify({
        startupDelayMs: 0,
        keyHoldMs: 19,
        postInputDelayMs: 10,
        defaultLoopDelayMs: MACRO_DELAY_MAX_MS + 1
      }),
      "utf8"
    );

    await expect(new MacroSettingsStore(baseDir).getSettings()).resolves.toEqual({
      startupDelayMs: 0,
      keyHoldMs: DEFAULT_MACRO_SETTINGS.keyHoldMs,
      postInputDelayMs: 10,
      defaultLoopDelayMs: DEFAULT_MACRO_SETTINGS.defaultLoopDelayMs
    });
  });

  it("writes normalized settings atomically and returns defensive copies", async () => {
    const store = new MacroSettingsStore(baseDir);
    const saved = await store.updateSettings({
      startupDelayMs: 25,
      keyHoldMs: 20,
      postInputDelayMs: 10,
      defaultLoopDelayMs: 0
    });
    saved.keyHoldMs = 999;

    await expect(store.getSettings()).resolves.toEqual({
      startupDelayMs: 25,
      keyHoldMs: 20,
      postInputDelayMs: 10,
      defaultLoopDelayMs: 0
    });
    await expect(readFile(join(baseDir, "macro-settings.json"), "utf8")).resolves.toContain(
      '"defaultLoopDelayMs": 0'
    );
    await expect(readFile(join(baseDir, "macro-settings.json.tmp"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("defines hard limits separately from recommended minimums", () => {
    expect(MACRO_SETTINGS_CONSTRAINTS.keyHoldMs).toEqual({ min: 20, max: 1000, recommendedMin: 30 });
    expect(MACRO_SETTINGS_CONSTRAINTS.postInputDelayMs).toEqual({ min: 10, max: 1000, recommendedMin: 30 });
    expect(MACRO_SETTINGS_CONSTRAINTS.defaultLoopDelayMs).toEqual({
      min: 0,
      max: MACRO_DELAY_MAX_MS,
      recommendedMin: 250
    });
    expect(isValidMacroSettingValue("keyHoldMs", 19)).toBe(false);
    expect(isValidMacroSettingValue("keyHoldMs", 20)).toBe(true);
    expect(isValidMacroSettingValue("startupDelayMs", 0)).toBe(true);
    expect(isValidMacroSettingValue("defaultLoopDelayMs", 0)).toBe(true);
    expect(isValidMacroSettingValue("defaultLoopDelayMs", MACRO_DELAY_MAX_MS)).toBe(true);
    expect(isValidMacroSettingValue("defaultLoopDelayMs", MACRO_DELAY_MAX_MS + 1)).toBe(false);
    expect(normalizeMacroSettings({ keyHoldMs: 0 })).toEqual(DEFAULT_MACRO_SETTINGS);
  });
});
