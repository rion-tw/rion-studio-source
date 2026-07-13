import { describe, expect, it } from "vitest";

import { normalizeEditorTitle } from "../src/renderer/src/app/editorTitle";

describe("editor page title", () => {
  it("keeps editable names on one line", () => {
    expect(normalizeEditorTitle("First\nSecond\r\nThird")).toBe("First Second Third");
  });

  it("limits editable names to the persisted name length", () => {
    expect(normalizeEditorTitle("a".repeat(81))).toBe("a".repeat(80));
  });
});
