import { describe, expect, it } from "vitest";

import { compareUtf8 } from "../src/electron/main/chromeProfileImportOrder";

describe("Chrome Profile import canonical order", () => {
  it("matches Rust str::cmp (UTF-8 bytes), not locale collation", () => {
    const names = ["auth", "_ga", "Token", "PHPSESSID", "\u{1F600}", "Ａ", "ä"];
    // Rust: ["PHPSESSID", "Token", "_ga", "auth", "ä", "Ａ", "😀"]
    expect([...names].sort(compareUtf8)).toEqual(["PHPSESSID", "Token", "_ga", "auth", "ä", "Ａ", "\u{1F600}"]);
    expect([...names].sort((a, b) => a.localeCompare(b))).not.toEqual([...names].sort(compareUtf8));
    expect(compareUtf8("same", "same")).toBe(0);
  });
});
