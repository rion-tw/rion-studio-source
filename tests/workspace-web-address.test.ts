// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displayWorkspaceWebUrl, resolveWorkspaceWebAddress } from "../src/shared/workspaceWebAddress";
import { WORKSPACE_WEB_CHROME_STATE_CHANNEL } from "../src/shared/workspaceWebChrome";

const { invoke, send, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(async () => new Promise(() => {})),
  send: vi.fn(),
  listeners: new Map<string, (event: unknown, value: unknown) => void>()
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("electron", () => ({ ipcRenderer: {
  send, on: (channel: string, handler: (event: unknown, value: unknown) => void) => listeners.set(channel, handler)
} }));

it.each([
  ["https://www.example.com/path?q=https://www.other.com#x", "example.com/path?q=https://www.other.com#x"],
  ["https://example.com/", "example.com/"],
  ["http://www.example.com/", "http://www.example.com/"],
  ["https://www2.example.com/", "www2.example.com/"]
])("displays %s as %s", (input, expected) => {
  expect(displayWorkspaceWebUrl(input)).toBe(expected);
});
it.each([
  ["example.com/path", "https://example.com/path"],
  ["http://localhost:4173/a", "http://localhost:4173/a"],
  ["localhost:4173/a", "https://localhost:4173/a"],
  ["127.0.0.1:8000/a", "https://127.0.0.1:8000/a"],
  ["[::1]:8000/a", "https://[::1]:8000/a"],
  ["example.com:8443/a", "https://example.com:8443/a"],
  ["貓", "https://www.google.com/search?q=%E8%B2%93"],
  ["  cats & dogs #1+2  ", "https://www.google.com/search?q=cats%20%26%20dogs%20%231%2B2"],
  ["cats", "https://www.google.com/search?q=cats"],
  ["", null], ["   ", null], ["https://", null], ["https:broken", null],
  ["https://bad host/", null], ["javascript:alert(1)", null], ["file:///tmp/x", null],
  ["https://user:secret@example.com", null]
])("resolves %s", (input, expected) => {
  expect(resolveWorkspaceWebAddress(input)).toBe(expected);
});

for (const platform of ["macos", "windows"] as const) {
  describe.each(["tauri", "electron"] as const)(`${platform} %s address integration`, (shell) => {
    let registered: Array<[string, EventListenerOrEventListenerObject]> = [];
    beforeEach(async () => {
      registered = [];
      const add = window.addEventListener.bind(window);
      vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
        registered.push([type, listener]);
        add(type, listener, options);
      });
      vi.resetModules(); invoke.mockClear(); send.mockClear(); listeners.clear();
      document.body.innerHTML = '<button id="back"></button><button id="forward"></button><button id="reload"></button><button id="home"></button><form id="location-form"><input id="location"></form>';
      window.__rionWorkspaceWebChromeIdentity = { capabilityToken: "token", generation: 1 };
      if (shell === "tauri") await import("../src/renderer/runtime-shell/runtimeWebChrome");
      else {
        await import("../src/electron/preload/workspaceWebChrome");
        window.dispatchEvent(new Event("DOMContentLoaded"));
      }
    });
    afterEach(() => {
      for (const [type, listener] of registered) window.removeEventListener(type, listener);
      vi.restoreAllMocks();
    });
    const project = (url: string) => {
      const state = { url, canGoBack: true, canGoForward: false, documentEpoch: 4 };
      if (shell === "tauri") window.__rionApplyWorkspaceWebChromeState?.(state);
      else {
        const { documentEpoch: _epoch, ...rest } = state;
        listeners.get(WORKSPACE_WEB_CHROME_STATE_CHANNEL)?.(null, {
          ...rest, surfaceId: "surface-a", generation: 1
        });
      }
    };
    it("restores full URLs on focus and latest committed state on blur and Escape", () => {
      const input = document.querySelector<HTMLInputElement>("#location")!;
      project("https://www.example.com/start");
      expect(input.value).toBe("example.com/start");
      input.focus(); expect(input.value).toBe("https://www.example.com/start");
      input.value = "draft";
      project("https://www.example.com/redirect");
      expect(input.value).toBe("draft");
      input.blur(); expect(input.value).toBe("example.com/redirect");
      input.focus(); input.value = "discard";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      expect(input.value).toBe("example.com/redirect");
      expect(document.activeElement).not.toBe(input);
    });
    it("submits encoded search and blocks composition and invalid URLs", () => {
      project("https://www.example.com/");
      const input = document.querySelector<HTMLInputElement>("#location")!;
      const form = document.querySelector("form")!;
      const submit = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
      input.focus(); input.value = "中文 & cats";
      invoke.mockClear(); send.mockClear();
      input.dispatchEvent(new CompositionEvent("compositionstart")); submit();
      const enter = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, cancelable: true });
      input.dispatchEvent(enter); expect(enter.defaultPrevented).toBe(true);
      expect(invoke).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
      input.dispatchEvent(new CompositionEvent("compositionend")); submit();
      const action = shell === "tauri" ? invoke.mock.calls.at(-1) : send.mock.calls.at(-1);
      expect(JSON.stringify(action)).toContain("https://www.google.com/search?q=%E4%B8%AD%E6%96%87%20%26%20cats");
      invoke.mockClear(); send.mockClear(); input.value = "file:///tmp/x"; submit();
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(invoke).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    });
  });
}
