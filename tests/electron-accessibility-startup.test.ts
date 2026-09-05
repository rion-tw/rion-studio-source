import { describe, expect, it, vi } from "vitest";

import { applyElectronAccessibilityStartupRequest } from
  "../src/electron/main/electronAccessibilityStartup";

describe("Electron accessibility startup", () => {
  it("enables support only for Chromium's explicit accessibility switch", () => {
    for (const requested of [false, true]) {
      const setAccessibilitySupportEnabled = vi.fn();
      applyElectronAccessibilityStartupRequest({
        commandLine: { hasSwitch: () => requested },
        setAccessibilitySupportEnabled
      });
      expect(setAccessibilitySupportEnabled).toHaveBeenCalledTimes(requested ? 1 : 0);
      if (requested) {
        expect(setAccessibilitySupportEnabled).toHaveBeenCalledWith(true);
      }
    }
  });
});
