import { describe, expect, it, vi } from "vitest";

import { normalizeEditorTitle, syncEditorTitle } from "../src/renderer/src/app/editorTitle";

describe("editor page title", () => {
  it("keeps editable names on one line", () => {
    expect(normalizeEditorTitle("First\nSecond\r\nThird")).toBe("First Second Third");
  });

  it("limits editable names to the persisted name length", () => {
    expect(normalizeEditorTitle("a".repeat(81))).toBe("a".repeat(80));
  });

  it("does not replace matching title content and disturb the active caret", () => {
    const setTextContent = vi.fn();
    const element = {} as HTMLElement;
    Object.defineProperty(element, "textContent", {
      configurable: true,
      get: () => "Existing title",
      set: setTextContent
    });

    syncEditorTitle(element, "Existing title");

    expect(setTextContent).not.toHaveBeenCalled();
  });

  it("synchronizes title content when the value changes externally", () => {
    const element = { textContent: "Old title" } as HTMLElement;

    syncEditorTitle(element, "New title");

    expect(element.textContent).toBe("New title");
  });

  it("removes browser-inserted nodes when an editable title is cleared", () => {
    const setTextContent = vi.fn();
    const element = { childNodes: [{}] } as unknown as HTMLElement;
    Object.defineProperty(element, "textContent", {
      configurable: true,
      get: () => "",
      set: setTextContent
    });

    syncEditorTitle(element, "");

    expect(setTextContent).toHaveBeenCalledWith("");
  });

});
