// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWindowsApplicationShortcuts } from "../src/renderer/src/hooks/useWindowsApplicationShortcuts";
import type { RionStudioApi } from "../src/shared/api";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "rionStudio");
  delete document.documentElement.dataset.platform;
});

describe("useWindowsApplicationShortcuts", () => {
  it("dispatches supported shortcuts through the typed bridge on Windows", async () => {
    const executeApplicationShortcut = vi.fn(() => Promise.resolve());
    installBridge(executeApplicationShortcut);
    document.documentElement.dataset.platform = "windows";
    render(<ShortcutHarness />);

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyN",
      ctrlKey: true,
      key: "n"
    });
    window.dispatchEvent(event);

    await waitFor(() => expect(executeApplicationShortcut).toHaveBeenCalledWith("newGameWindow"));
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not install Windows application shortcuts on macOS", () => {
    const executeApplicationShortcut = vi.fn(() => Promise.resolve());
    installBridge(executeApplicationShortcut);
    document.documentElement.dataset.platform = "mac";
    render(<ShortcutHarness />);

    window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      code: "F11",
      key: "F11"
    }));

    expect(executeApplicationShortcut).not.toHaveBeenCalled();
  });
});

function ShortcutHarness(): JSX.Element {
  useWindowsApplicationShortcuts(true);
  return <div />;
}

function installBridge(executeApplicationShortcut: () => Promise<void>): void {
  Object.defineProperty(window, "rionStudio", {
    configurable: true,
    value: { executeApplicationShortcut } as unknown as RionStudioApi
  });
}
