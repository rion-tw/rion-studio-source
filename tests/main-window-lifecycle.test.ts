import { describe, expect, it, vi } from "vitest";

import { handleMainWindowClose } from "../src/main/window/mainWindowLifecycle";

describe("main window lifecycle", () => {
  it("hides the main window instead of closing it during normal use", () => {
    const event = { preventDefault: vi.fn() };
    const window = { hide: vi.fn() };

    handleMainWindowClose(event, window, false);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
  });

  it("allows the main window to close while the application is quitting", () => {
    const event = { preventDefault: vi.fn() };
    const window = { hide: vi.fn() };

    handleMainWindowClose(event, window, true);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(window.hide).not.toHaveBeenCalled();
  });
});
