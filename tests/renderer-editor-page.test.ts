import { describe, expect, it, vi } from "vitest";

import {
  focusEditorTitle,
  normalizeEditorTitle
} from "../src/renderer/src/app/editorTitle";

describe("editor page title", () => {
  it("keeps editable names on one line", () => {
    expect(normalizeEditorTitle("First\nSecond\r\nThird")).toBe("First Second Third");
  });

  it("limits editable names to the persisted name length", () => {
    expect(normalizeEditorTitle("a".repeat(81))).toBe("a".repeat(80));
  });

  it("focuses the name with the caret at the end when an editor opens", () => {
    const element = { focus: vi.fn() } as unknown as HTMLElement;
    const range = {
      collapse: vi.fn(),
      selectNodeContents: vi.fn()
    } as unknown as Range;
    const selection = {
      addRange: vi.fn(),
      removeAllRanges: vi.fn()
    } as unknown as Selection;

    focusEditorTitle(element, selection, () => range);

    expect(element.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(range.selectNodeContents).toHaveBeenCalledWith(element);
    expect(range.collapse).toHaveBeenCalledWith(false);
    expect(selection.removeAllRanges).toHaveBeenCalledOnce();
    expect(selection.addRange).toHaveBeenCalledWith(range);
  });

  it("still focuses the name when text selection is unavailable", () => {
    const element = { focus: vi.fn() } as unknown as HTMLElement;
    const createRange = vi.fn();

    focusEditorTitle(element, null, createRange);

    expect(element.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(createRange).not.toHaveBeenCalled();
  });
});
