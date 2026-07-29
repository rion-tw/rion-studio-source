import { describe, expect, it } from "vitest";

import {
  applicationShortcutForKeyEvent,
  type ApplicationShortcutKeyEvent
} from "../src/shared/applicationShortcuts";

const keyEvent = (
  code: string,
  overrides: Partial<ApplicationShortcutKeyEvent> = {}
): ApplicationShortcutKeyEvent => ({
  altKey: false,
  code,
  ctrlKey: false,
  isComposing: false,
  metaKey: false,
  repeat: false,
  shiftKey: false,
  ...overrides
});

describe("Windows application shortcut mapping", () => {
  it.each([
    ["KeyN", { ctrlKey: true }, "newGameWindow"],
    ["F11", {}, "toggleFullscreen"],
    ["Digit0", { ctrlKey: true }, "zoomReset"],
    ["Numpad0", { ctrlKey: true }, "zoomReset"],
    ["Minus", { ctrlKey: true }, "zoomOut"],
    ["NumpadSubtract", { ctrlKey: true }, "zoomOut"],
    ["Equal", { ctrlKey: true }, "zoomIn"],
    ["Equal", { ctrlKey: true, shiftKey: true }, "zoomIn"],
    ["NumpadAdd", { ctrlKey: true }, "zoomIn"]
  ] as const)("maps %s to %s", (code, modifiers, command) => {
    expect(applicationShortcutForKeyEvent(keyEvent(code, modifiers))).toBe(command);
  });

  it("rejects composing, foreign modifiers, and modified discrete commands", () => {
    expect(applicationShortcutForKeyEvent(keyEvent("KeyN", { ctrlKey: true, isComposing: true }))).toBeUndefined();
    expect(applicationShortcutForKeyEvent(keyEvent("KeyN", { ctrlKey: true, shiftKey: true }))).toBeUndefined();
    expect(applicationShortcutForKeyEvent(keyEvent("F11", { altKey: true }))).toBeUndefined();
    expect(applicationShortcutForKeyEvent(keyEvent("Equal", { ctrlKey: true, metaKey: true }))).toBeUndefined();
    expect(applicationShortcutForKeyEvent(keyEvent("NumpadAdd", { ctrlKey: true, shiftKey: true }))).toBeUndefined();
  });

  it("ignores repeated discrete commands while allowing repeated zoom", () => {
    expect(applicationShortcutForKeyEvent(keyEvent("KeyN", { ctrlKey: true, repeat: true }))).toBeUndefined();
    expect(applicationShortcutForKeyEvent(keyEvent("F11", { repeat: true }))).toBeUndefined();
    expect(applicationShortcutForKeyEvent(keyEvent("Equal", { ctrlKey: true, repeat: true }))).toBe("zoomIn");
  });
});
