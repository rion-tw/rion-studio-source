/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  document.documentElement.lang = "en";
  document.body.innerHTML = `
    <div data-windows-window-controls>
      <button data-window-control="minimize"></button>
      <button data-window-control="maximize"></button>
      <button data-window-control="close"></button>
    </div>
    <div id="root">
      <div data-startup-loading aria-label="Loading Rion Studio">
        <span data-startup-loading-label>Loading Rion Studio</span>
      </div>
    </div>
  `;
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  delete window.__rionShowStartupFailure;
  Reflect.deleteProperty(window, "rionStudio");
});

describe("pre-React startup fallback", () => {
  it("preserves structured native startup errors", async () => {
    const { startupFailureMessage } = await import("../src/renderer/src/app/startupFallback");

    expect(startupFailureMessage({
      code: "SHELL_STARTUP_FAILED",
      message: "native database failed"
    })).toBe("native database failed");
  });

  it("restores the original error card and treats native details as text", async () => {
    const { showStartupFailure } = await import("../src/renderer/src/app/startupFallback");
    const unsafeDetail = '<img src=x onerror="window.__unsafe=true">';

    showStartupFailure(unsafeDetail);

    const root = document.getElementById("root")!;
    expect(root.querySelector(".boot-fallback")?.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(root.querySelector(".boot-fallback-icon")).not.toBeNull();
    expect(root.querySelector(".boot-fallback-error-mark")?.textContent).toBe("!");
    expect(root.querySelector("[data-startup-failure-title]")?.textContent)
      .toBe("Unable to start Rion Studio");
    expect(root.querySelector(".boot-fallback-status p")?.textContent).toBe(unsafeDetail);
    expect(root.querySelectorAll("img")).toHaveLength(1);
  });

  it("loads the stored startup language before React mounts", async () => {
    localStorage.setItem("rion-studio-language", "zh-TW");
    const { showStartupFailure } = await import("../src/renderer/src/app/startupFallback");
    showStartupFailure("測試錯誤");

    await vi.waitFor(() => {
      expect(document.documentElement.lang).toBe("zh-TW");
      expect(document.querySelector("[data-startup-failure-title]")?.textContent)
        .toBe("無法啟動 Rion Studio");
    });
  });

  it("keeps localized Windows controls active before the React root mounts", async () => {
    const minimizeCurrentWindow = vi.fn(() => Promise.resolve());
    const toggleCurrentWindowMaximize = vi.fn(() => Promise.resolve());
    const requestCurrentWindowClose = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        minimizeCurrentWindow,
        requestCurrentWindowClose,
        toggleCurrentWindowMaximize
      }
    });

    await import("../src/renderer/src/app/startupFallback");
    document.querySelector<HTMLButtonElement>('[data-window-control="minimize"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-window-control="maximize"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-window-control="close"]')?.click();

    expect(minimizeCurrentWindow).toHaveBeenCalledOnce();
    expect(toggleCurrentWindowMaximize).toHaveBeenCalledOnce();
    expect(requestCurrentWindowClose).toHaveBeenCalledOnce();
    const maximize = document.querySelector<HTMLButtonElement>('[data-window-control="maximize"]')!;
    expect(maximize.ariaLabel).toBe("Maximize");
    document.documentElement.dataset.windowMaximized = "true";
    await vi.waitFor(() => expect(maximize.ariaLabel).toBe("Restore"));
  });
});
