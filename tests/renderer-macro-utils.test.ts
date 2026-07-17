import { describe, expect, it } from "vitest";

import {
  createMacroRunKey,
  formatMacroActivationMode,
  formatMacroIntervalPreset,
  formatMacroRepeat,
  formatMacroShortcut,
  getCallableMacroTargets,
  getMacroPartialStartCounts,
  isMacroIntervalPreset,
  isValidMacroInterval,
  MACRO_INTERVAL_OPTIONS,
  MACRO_INTERVAL_PRESETS,
  summarizeMacroSteps
} from "../src/renderer/src/features/macros/macroUtils";
import type { Translator } from "../src/renderer/src/i18n";
import { MACRO_DELAY_MAX_MS } from "../src/shared/macroSettings";

const t: Translator = (key) =>
  (
    {
      "macro.step.click": "Click",
      "macro.step.delay": "Delay",
      "macro.step.hold": "Hold",
      "macro.step.key": "Key",
      "macro.step.macro": "Run macro",
      "macroForm.intervalMilliseconds": "{value} ms",
      "macroForm.intervalSeconds": "{value} sec",
      "macroForm.intervalNone": "0 ms · No extra wait",
      "macroForm.activation.toggle": "Click / toggle",
      "macroForm.activation.whileHeld": "While held",
      "macros.noShortcut": "No shortcut",
      "macros.repeat.loop": "Wait {ms} ms after completion",
      "macros.repeat.loopImmediate": "Schedule the next run after completion",
      "macros.repeat.once": "Once",
      "macros.steps.empty": "No steps",
      "macros.steps.more": "+{count} more",
      "macros.unknownMacro": "Unknown macro"
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

    expect(
      summarizeMacroSteps(
        [{ id: "call", type: "macro", macroId: "child" }],
        t,
        new Map([["child", "After thunder"]])
      )
    ).toBe("Run macro:After thunder");

    expect(summarizeMacroSteps(
      [{ id: "hold", type: "key", code: "KeyW", action: "hold_until_stop" }],
      t
    )).toBe("Hold:W");
  });

  it("formats repeat settings and run keys", () => {
    expect(formatMacroActivationMode(undefined, t)).toBe("Click / toggle");
    expect(formatMacroActivationMode("while_held", t)).toBe("While held");
    expect(formatMacroRepeat({ type: "once" }, t)).toBe("Once");
    expect(formatMacroRepeat({ type: "loop", intervalMs: 500 }, t)).toBe("Wait 500 ms after completion");
    expect(formatMacroRepeat({ type: "loop", intervalMs: 0 }, t)).toBe("Schedule the next run after completion");
    expect(createMacroRunKey("role-1", "macro-1")).toBe("role-1:macro-1");
  });

  it("reports partial starts only when assigned roles were skipped", () => {
    const macro = {
      id: "macro-1",
      enabled: true,
      name: "Partial",
      roleIds: ["role-1", "role-2"],
      repeat: { type: "once" as const },
      steps: [{ id: "step-1", type: "key" as const, code: "F2" }],
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    };
    const status = {
      roleId: "role-1",
      macroId: macro.id,
      state: "running" as const,
      startedAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    };

    expect(getMacroPartialStartCounts(macro, [status])).toEqual({ skippedCount: 1, startedCount: 1 });
    expect(getMacroPartialStartCounts(macro, [status, { ...status, roleId: "role-2" }])).toBeUndefined();
  });

  it("provides ordered interval presets and formats their units", () => {
    expect(MACRO_INTERVAL_PRESETS).toEqual([0, 250, 500, 1000, 2000, 5000, 10000]);
    expect(MACRO_INTERVAL_OPTIONS).toEqual([0, 250, 500, 1000, 2000, 5000, 10000, "custom"]);
    expect(formatMacroIntervalPreset(0, t)).toBe("0 ms · No extra wait");
    expect(formatMacroIntervalPreset(250, t)).toBe("250 ms");
    expect(formatMacroIntervalPreset(1000, t)).toBe("1 sec");
    expect(formatMacroIntervalPreset(10000, t)).toBe("10 sec");
  });

  it("distinguishes preset and valid custom intervals", () => {
    expect(isMacroIntervalPreset(500)).toBe(true);
    expect(isMacroIntervalPreset(50)).toBe(false);
    expect(isMacroIntervalPreset(100)).toBe(false);
    expect(isMacroIntervalPreset(333)).toBe(false);
    expect(isValidMacroInterval(50)).toBe(true);
    expect(isValidMacroInterval(100)).toBe(true);
    expect(isValidMacroInterval(1)).toBe(true);
    expect(isValidMacroInterval(MACRO_DELAY_MAX_MS)).toBe(true);
    expect(isValidMacroInterval(0)).toBe(true);
    expect(isValidMacroInterval(MACRO_DELAY_MAX_MS + 1)).toBe(false);
    expect(isValidMacroInterval(1.5)).toBe(false);
  });

  it("offers only run-once macro targets that cannot create a dependency cycle", () => {
    const base = {
      enabled: true,
      roleIds: ["role-1"],
      repeat: { type: "once" as const },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    };
    const macros = [
      { ...base, id: "a", name: "A", steps: [{ id: "key-a", type: "key" as const, code: "F1" }] },
      {
        ...base,
        id: "b",
        name: "B",
        enabled: false,
        steps: [{ id: "call-a", type: "macro" as const, macroId: "a" }]
      },
      {
        ...base,
        id: "loop",
        name: "Loop",
        repeat: { type: "loop" as const, intervalMs: 100 },
        steps: [{ id: "wait", type: "delay" as const, ms: 1 }]
      },
      {
        ...base,
        id: "held",
        name: "Held",
        steps: [{
          id: "held-key",
          type: "key" as const,
          code: "KeyW",
          action: "hold_until_stop" as const
        }]
      },
      { ...base, id: "c", name: "C", steps: [{ id: "key-c", type: "key" as const, code: "F3" }] }
    ];

    expect(getCallableMacroTargets(macros, "a").map((macro) => macro.id)).toEqual(["c"]);
    expect(getCallableMacroTargets(macros, "c").map((macro) => macro.id)).toEqual(["a", "b"]);
    expect(getCallableMacroTargets(macros).map((macro) => macro.id)).toEqual(["a", "b", "c"]);
  });
});
