// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn((): Promise<unknown> => Promise.resolve({ status: "applied" }))
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  vi.resetModules();
  invoke.mockClear();
  document.documentElement.innerHTML = `
    <head></head>
    <body>
      <main id="tab-status" role="status" aria-live="polite">
        <div id="loading-status" hidden><span class="loading-spinner"></span></div>
        <div id="failure-status" hidden>
          <h1 id="failure-title"></h1>
          <p id="failure-body"></p>
          <button id="failure-retry"></button>
        </div>
      </main>
    </body>`;
  window.__rionInitialRuntimeTabStatus = undefined;
  window.__rionApplyRuntimeTabStatus = undefined;
});

it("shows an accessible loading spinner without failure actions", async () => {
  window.__rionInitialRuntimeTabStatus = {
    accessibilityLabel: "正在開啟「米娜」。",
    body: "",
    identity: {
      attemptId: "attempt-loading",
      phase: "loading",
      tabId: "tab-1",
      windowGeneration: 7,
      windowId: "window-1"
    },
    language: "zh-TW",
    retryLabel: "",
    state: "loading",
    tabName: "米娜",
    theme: "dark",
    title: ""
  };
  await import("../src/renderer/runtime-shell/runtimeTabStatus");

  const status = document.querySelector<HTMLElement>("#tab-status")!;
  expect(status.dataset.state).toBe("loading");
  expect(status.ariaLabel).toBe("正在開啟「米娜」。");
  expect(status.getAttribute("role")).toBe("status");
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(document.documentElement.lang).toBe("zh-TW");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  expect(document.querySelector<HTMLElement>("#loading-status")?.hidden).toBe(false);
  expect(document.querySelector<HTMLElement>("#failure-status")?.hidden).toBe(true);
  expect(document.querySelector<HTMLButtonElement>("#failure-retry")?.disabled).toBe(true);

  document.querySelector<HTMLButtonElement>("#failure-retry")?.click();
  expect(invoke).not.toHaveBeenCalled();
});

it("projects the authoritative failed identity and submits one fenced retry", async () => {
  const identity = {
    attemptId: "attempt-1",
    phase: "failed" as const,
    tabId: "tab-1",
    windowGeneration: 7,
    windowId: "window-1"
  };
  window.__rionInitialRuntimeTabStatus = {
    accessibilityLabel: "無法開啟「米娜」",
    body: "此分頁未能完成啟動，請再試一次。",
    identity,
    language: "zh-TW",
    retryLabel: "再試一次",
    state: "failed",
    tabName: "米娜",
    theme: "dark",
    title: "無法開啟「米娜」"
  };
  await import("../src/renderer/runtime-shell/runtimeTabStatus");

  const retry = document.querySelector<HTMLButtonElement>("#failure-retry")!;
  expect(document.documentElement.lang).toBe("zh-TW");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.querySelector("#failure-title")?.textContent).toBe("無法開啟「米娜」");
  expect(document.querySelector<HTMLElement>("#loading-status")?.hidden).toBe(true);
  expect(document.querySelector<HTMLElement>("#failure-status")?.hidden).toBe(false);
  retry.click();
  retry.click();

  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
    action: { identity, type: "retryFailed" }
  });
  expect(retry.disabled).toBe(true);
});

it("replaces a stale panel projection without moving keyboard focus", async () => {
  await import("../src/renderer/runtime-shell/runtimeTabStatus");
  const retry = document.querySelector<HTMLButtonElement>("#failure-retry")!;
  retry.focus();
  window.__rionApplyRuntimeTabStatus?.({
    accessibilityLabel: "Couldn’t Open “Beta”",
    body: "Try again.",
    identity: {
      attemptId: "attempt-2",
      phase: "failed",
      tabId: "tab-2",
      windowGeneration: 8,
      windowId: "window-2"
    },
    language: "en",
    retryLabel: "Try Again",
    state: "failed",
    tabName: "Beta",
    theme: "light",
    title: "Couldn’t Open “Beta”"
  });

  expect(document.activeElement).toBe(retry);
  expect(retry.disabled).toBe(false);
  expect(document.querySelector("#failure-title")?.textContent).toBe("Couldn’t Open “Beta”");
});

it("replaces a failed panel with loading and fences the stale retry control", async () => {
  await import("../src/renderer/runtime-shell/runtimeTabStatus");
  const retry = document.querySelector<HTMLButtonElement>("#failure-retry")!;
  window.__rionApplyRuntimeTabStatus?.({
    accessibilityLabel: "Couldn’t Open “Beta”",
    body: "Try again.",
    identity: {
      attemptId: "attempt-failed",
      phase: "failed",
      tabId: "tab-2",
      windowGeneration: 8,
      windowId: "window-2"
    },
    language: "en",
    retryLabel: "Try Again",
    state: "failed",
    tabName: "Beta",
    theme: "light",
    title: "Couldn’t Open “Beta”"
  });
  retry.focus();
  window.__rionApplyRuntimeTabStatus?.({
    accessibilityLabel: "Opening “Beta”.",
    body: "",
    identity: {
      attemptId: "attempt-retry",
      phase: "attaching",
      tabId: "tab-2",
      windowGeneration: 8,
      windowId: "window-2"
    },
    language: "en",
    retryLabel: "",
    state: "loading",
    tabName: "Beta",
    theme: "light",
    title: ""
  });

  expect(document.activeElement).toBe(retry);
  expect(retry.disabled).toBe(true);
  expect(document.querySelector<HTMLElement>("#loading-status")?.hidden).toBe(false);
  retry.click();
  expect(invoke).not.toHaveBeenCalled();
});
