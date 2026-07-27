/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  document.documentElement.lang = "en";
  document.body.innerHTML = `
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
});

describe("pre-React startup fallback", () => {
  it("restores the original error card and treats native details as text", async () => {
    const { showStartupFailure } = await import("../src/renderer/src/app/startupFallback");
    const unsafeDetail = '<img src=x onerror="window.__unsafe=true">';

    showStartupFailure(unsafeDetail);

    const root = document.getElementById("root")!;
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
});
