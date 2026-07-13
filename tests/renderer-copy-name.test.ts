import { describe, expect, it } from "vitest";

import { MAX_COPY_NAME_LENGTH, createCopyName } from "../src/renderer/src/app/copyName";

describe("copy name helpers", () => {
  it("creates the first copy name from the original name and suffix", () => {
    expect(createCopyName("Mage", ["Mage"], "Copy")).toBe("Mage Copy");
  });

  it("detects existing copy names case-insensitively", () => {
    expect(createCopyName("Mage", ["Mage", "mage copy"], "Copy")).toBe("Mage Copy 2");
  });

  it("increments the copy number until the name is unique", () => {
    expect(createCopyName("Mage", ["Mage", "Mage Copy", "Mage Copy 2"], "Copy")).toBe("Mage Copy 3");
  });

  it("truncates long original names to keep the copy name within the store limit", () => {
    const copyName = createCopyName("x".repeat(100), ["x".repeat(100)], "Copy");

    expect(copyName).toHaveLength(MAX_COPY_NAME_LENGTH);
    expect(copyName).toMatch(/ Copy$/);
  });
});
