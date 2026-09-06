import { describe, expect, it } from "vitest";

import { canonicalChromiumPath, chromiumPathKey } from
  "../src/electron/main/chromiumSessionPath";
import { ChromiumSessionOwnershipLedger } from
  "../src/electron/main/chromiumSessionOwnershipLedger";

describe("Chromium Session path boundary", () => {
  it.each([
    ["darwin" as const, "/Users/user/Rion Data/roles/role/browser/chromium"],
    ["win32" as const, "C:\\Rion Data\\roles\\role\\browser\\chromium"],
    ["win32" as const, "\\\\server\\share\\Rion Data\\roles\\role\\browser\\chromium"]
  ])("admits ordinary %s paths without changing their identity", (platform, path) => {
    expect(canonicalChromiumPath(path, platform)).toBe(path);
    const ledger = new ChromiumSessionOwnershipLedger(platform);
    expect(ledger.claim("role:role", path, {}).path).toBe(path);
  });

  it.each([
    "\\\\?\\C:\\RionData\\roles\\role\\browser\\chromium",
    "\\\\?\\UNC\\server\\share\\roles\\role\\browser\\chromium",
    "\\\\.\\C:\\RionData\\roles\\role\\browser\\chromium",
    "C:relative",
    "\\RionData\\chromium",
    "\\\\server",
    "C:\\RionData\\..\\other",
    "C:/RionData/chromium"
  ])("rejects unsafe or noncanonical Windows admission before binding: %s", (path) => {
    expect(canonicalChromiumPath(path, "win32")).toBeNull();
    const ledger = new ChromiumSessionOwnershipLedger("win32");
    expect(() => ledger.claim("role:role", path, {})).toThrowError(
      expect.objectContaining({ code: "ELECTRON_CHROMIUM_SESSION_OWNERSHIP_PATH_INVALID" })
    );
    expect(ledger.activeCount).toBe(0);
  });

  it.each(["darwin", "win32"] as const)("rejects malformed %s wire paths", (platform) => {
    for (const path of [null, 3, "", "relative", "/bad\0path"]) {
      expect(canonicalChromiumPath(path, platform)).toBeNull();
    }
  });

  it("preserves the existing platform-specific alias policy", () => {
    expect(chromiumPathKey("C:\\RionData", "win32"))
      .toBe(chromiumPathKey("c:\\riondata", "win32"));
    expect(chromiumPathKey("/RionData", "darwin"))
      .not.toBe(chromiumPathKey("/riondata", "darwin"));
  });
});
