import { describe, expect, it } from "vitest";

import { MacroSettingsStore } from "../src/main/macros/MacroSettingsStore";
import {
  DEFAULT_MACRO_SETTINGS,
  MACRO_DELAY_MAX_MS,
  MACRO_SETTINGS_CONSTRAINTS,
  isValidMacroSettingValue,
  normalizeMacroSettings
} from "../src/shared/macroSettings";
import { MemoryStateRepository } from "./helpers/memoryStateRepository";

describe("MacroSettingsStore", () => {
  it("reads defaults from the Rust state client and returns defensive copies", async () => {
    const store = new MacroSettingsStore("/unused", new MemoryStateRepository());
    await expect(store.getSettings()).resolves.toEqual(DEFAULT_MACRO_SETTINGS);
    const saved = await store.updateSettings({
      startupDelayMs: 25,
      keyHoldMs: 20,
      postInputDelayMs: 10,
      defaultLoopDelayMs: 0
    });
    saved.keyHoldMs = 999;
    await expect(store.getSettings()).resolves.toMatchObject({ keyHoldMs: 20 });
  });

  it("defines hard limits separately from recommended minimums", () => {
    expect(MACRO_SETTINGS_CONSTRAINTS.keyHoldMs).toEqual({ min: 20, max: 1000, recommendedMin: 30 });
    expect(MACRO_SETTINGS_CONSTRAINTS.defaultLoopDelayMs.max).toBe(MACRO_DELAY_MAX_MS);
    expect(isValidMacroSettingValue("keyHoldMs", 19)).toBe(false);
    expect(isValidMacroSettingValue("keyHoldMs", 20)).toBe(true);
    expect(normalizeMacroSettings({ keyHoldMs: 0 })).toEqual(DEFAULT_MACRO_SETTINGS);
  });
});
