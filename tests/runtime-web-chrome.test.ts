// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve())
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function installChromeDocument(): void {
  document.body.innerHTML = `
    <button id="back"></button>
    <button id="forward"></button>
    <button id="reload"></button>
    <button id="home"></button>
    <form id="location-form"><input id="location" /></form>
  `;
  window.__rionWorkspaceWebChromeIdentity = {
    capabilityToken: "token",
    generation: 9
  };
}

beforeEach(() => {
  vi.resetModules();
  invoke.mockClear();
  invoke.mockResolvedValue(undefined);
  installChromeDocument();
});

describe("Workspace Web sibling chrome", () => {
  it("normalizes only HTTP(S) addresses without treating text as search", async () => {
    const { normalizeWorkspaceWebUrl } = await import(
      "../src/renderer/runtime-shell/runtimeWebChrome"
    );

    expect(normalizeWorkspaceWebUrl("youtube.com/watch?v=abc")).toBe(
      "https://youtube.com/watch?v=abc"
    );
    expect(normalizeWorkspaceWebUrl("http://localhost:4173/path")).toBe(
      "http://localhost:4173/path"
    );
    expect(normalizeWorkspaceWebUrl("localhost:4173/path")).toBe(
      "https://localhost:4173/path"
    );
    expect(normalizeWorkspaceWebUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeWorkspaceWebUrl("youtube cats")).toBeNull();
  });

  it("projects history state, navigates on Enter, restores on Escape, and sends home", async () => {
    await import("../src/renderer/runtime-shell/runtimeWebChrome");
    invoke.mockClear();
    const input = document.querySelector<HTMLInputElement>("#location")!;
    const form = document.querySelector<HTMLFormElement>("#location-form")!;

    window.__rionApplyWorkspaceWebChromeState?.({
      canGoBack: true,
      canGoForward: false,
      documentEpoch: 4,
      url: "https://www.youtube.com/"
    });
    expect(document.querySelector<HTMLButtonElement>("#back")!.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>("#forward")!.disabled).toBe(true);

    input.value = "netflix.com";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(invoke).toHaveBeenLastCalledWith("rion_workspace_web_chrome_action", {
      action: {
        capabilityToken: "token",
        documentEpoch: 4,
        generation: 9,
        type: "navigate",
        url: "https://netflix.com/"
      }
    });

    input.value = "editing.example";
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(input.value).toBe("https://www.youtube.com/");

    document.querySelector<HTMLButtonElement>("#home")!.click();
    expect(invoke).toHaveBeenLastCalledWith("rion_workspace_web_chrome_action", {
      action: {
        capabilityToken: "token",
        documentEpoch: 4,
        generation: 9,
        type: "home"
      }
    });
  });
});
