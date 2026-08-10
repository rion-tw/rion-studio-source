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
      <main id="failure-status"><h1 id="failure-title"></h1><p id="failure-body"></p><button id="failure-retry"></button></main>
    </body>`;
  window.__rionInitialRuntimeTabFailureStatus = undefined;
  window.__rionApplyRuntimeTabFailureStatus = undefined;
});

it("projects the authoritative failed identity and submits one fenced retry", async () => {
  const identity = {
    attemptId: "attempt-1",
    phase: "failed" as const,
    tabId: "tab-1",
    windowGeneration: 7,
    windowId: "window-1"
  };
  window.__rionInitialRuntimeTabFailureStatus = {
    body: "此分頁未能完成啟動，請再試一次。",
    identity,
    language: "zh-TW",
    retryLabel: "再試一次",
    tabName: "米娜",
    theme: "dark",
    title: "無法開啟「米娜」"
  };
  await import("../src/renderer/runtime-shell/runtimeTabStatus");

  const retry = document.querySelector<HTMLButtonElement>("#failure-retry")!;
  expect(document.documentElement.lang).toBe("zh-TW");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.querySelector("#failure-title")?.textContent).toBe("無法開啟「米娜」");
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
  window.__rionApplyRuntimeTabFailureStatus?.({
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
    tabName: "Beta",
    theme: "light",
    title: "Couldn’t Open “Beta”"
  });

  expect(document.activeElement).toBe(retry);
  expect(retry.disabled).toBe(false);
  expect(document.querySelector("#failure-title")?.textContent).toBe("Couldn’t Open “Beta”");
});
