// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { formatMacroShortcut, isBareEscape } from "../src/renderer/src/features/macros/macroUtils";
import type { Translator } from "../src/renderer/src/i18n";

const t = ((key: string) => key) as Translator;

afterEach(() => { delete document.documentElement.dataset.platform; });

describe("macro shortcut labels", () => {
  it.each([
    ["windows", "Ctrl+Alt+Shift+Win+F1"],
    ["mac", "Ctrl+⌥+⇧+⌘+F1"],
    ["linux", "Ctrl+Alt+Shift+Meta+F1"]
  ])("lists modifiers with the same %s labels as the editor", (platform, expected) => {
    if (platform !== "linux") document.documentElement.dataset.platform = platform;
    expect(formatMacroShortcut({ code: "F1", ctrl: true, alt: true, shift: true, meta: true }, t)).toBe(expected);
  });
});

describe("key recorder cancellation", () => {
  const key = (code: string, modifiers: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) =>
    ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers });

  it("treats only a bare Escape as cancel, so modified Escape can still be recorded", () => {
    expect(isBareEscape(key("Escape"))).toBe(true);
    for (const modifier of ["ctrlKey", "altKey", "shiftKey", "metaKey"] as const) {
      expect(isBareEscape(key("Escape", { [modifier]: true }))).toBe(false);
    }
    expect(isBareEscape(key("Tab"))).toBe(false);
  });
});
