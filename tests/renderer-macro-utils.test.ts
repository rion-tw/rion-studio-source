import { describe, expect, it } from "vitest";

import {
  createMacroRunKey,
  formatMacroIntervalPreset,
  formatMacroRepeat,
  formatMacroShortcut,
  isMacroIntervalPreset,
  isValidMacroInterval,
  MACRO_INTERVAL_OPTIONS,
  MACRO_INTERVAL_PRESETS,
  summarizeMacroSteps
} from "../src/renderer/src/features/macros/macroUtils";
import type { Translator } from "../src/renderer/src/i18n";

const t: Translator = (key) =>
  (
    {
      "macro.step.click": "Click",
      "macro.step.delay": "Delay",
      "macro.step.key": "Key",
      "macroForm.intervalMilliseconds": "{value} ms",
      "macroForm.intervalSeconds": "{value} sec",
      "macros.noShortcut": "No shortcut",
      "macros.repeat.loop": "Every {ms} ms",
      "macros.repeat.once": "Once",
      "macros.steps.empty": "No steps",
      "macros.steps.more": "+{count} more"
    } as Record<string, string>
  )[key] ?? key;

describe("macroUtils", () => {
  it("formats shortcut labels from physical codes", () => {
    expect(formatMacroShortcut(undefined, t)).toBe("No shortcut");
    expect(formatMacroShortcut({ code: "KeyA", ctrl: true, alt: false, shift: true, meta: false }, t)).toBe(
      "Ctrl+Shift+A"
    );
    expect(formatMacroShortcut({ code: "Digit4", ctrl: false, alt: true, shift: false, meta: false }, t)).toBe(
      "Alt+4"
    );
  });

  it("summarizes macro steps compactly", () => {
    expect(
      summarizeMacroSteps(
        [
          { id: "1", type: "key", code: "F2" },
          { id: "2", type: "click", xPercent: 50, yPercent: 25 },
          { id: "3", type: "delay", ms: 300 }
        ],
        t
      )
    ).toBe("Key:F2 > Click:X 50%, Y 25% > Delay:300ms");

    expect(
      summarizeMacroSteps(
        [
          { id: "1", type: "key", code: "F1" },
          { id: "2", type: "key", code: "F2" },
          { id: "3", type: "key", code: "F3" },
          { id: "4", type: "key", code: "F4" },
          { id: "5", type: "key", code: "F5" }
        ],
        t
      )
    ).toBe("Key:F1 > Key:F2 > Key:F3 > Key:F4 > +1 more");
  });

  it("formats repeat settings and run keys", () => {
    expect(formatMacroRepeat({ type: "once" }, t)).toBe("Once");
    expect(formatMacroRepeat({ type: "loop", intervalMs: 500 }, t)).toBe("Every 500 ms");
    expect(createMacroRunKey("role-1", "macro-1")).toBe("role-1:macro-1");
  });

  it("provides ordered interval presets and formats their units", () => {
    expect(MACRO_INTERVAL_PRESETS).toEqual([50, 100, 250, 500, 1000, 2000, 5000, 10000]);
    expect(MACRO_INTERVAL_OPTIONS).toEqual([50, 100, 250, 500, 1000, 2000, 5000, 10000, "custom"]);
    expect(formatMacroIntervalPreset(50, t)).toBe("50 ms");
    expect(formatMacroIntervalPreset(1000, t)).toBe("1 sec");
    expect(formatMacroIntervalPreset(10000, t)).toBe("10 sec");
  });

  it("distinguishes preset and valid custom intervals", () => {
    expect(isMacroIntervalPreset(500)).toBe(true);
    expect(isMacroIntervalPreset(333)).toBe(false);
    expect(isValidMacroInterval(1)).toBe(true);
    expect(isValidMacroInterval(600000)).toBe(true);
    expect(isValidMacroInterval(0)).toBe(false);
    expect(isValidMacroInterval(600001)).toBe(false);
    expect(isValidMacroInterval(1.5)).toBe(false);
  });
});
