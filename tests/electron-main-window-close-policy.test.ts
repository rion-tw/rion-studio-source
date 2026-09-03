import { describe, expect, it, vi } from "vitest";

import { applyElectronMainWindowClosePolicy } from
  "../src/electron/main/mainWindowClosePolicy";

describe("Electron main-window close policy", () => {
  it("prevents native destruction and hides the main window before final quit", () => {
    const preventDefault = vi.fn();
    const hide = vi.fn();

    expect(applyElectronMainWindowClosePolicy({
      hide,
      isFinalCloseAdmitted: () => false
    }, { preventDefault })).toBe("hidden");

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();
  });

  it("allows exact native destruction only after the Core drain commits", () => {
    const preventDefault = vi.fn();
    const hide = vi.fn();

    expect(applyElectronMainWindowClosePolicy({
      hide,
      isFinalCloseAdmitted: () => true
    }, { preventDefault })).toBe("admitted");

    expect(preventDefault).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
  });
});
