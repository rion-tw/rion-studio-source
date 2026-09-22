// @vitest-environment jsdom
import { workspaceWebChromeCopy } from "../src/electron/main/workspaceWebStatus";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displayWorkspaceWebUrl, resolveWorkspaceWebAddress } from "../src/shared/workspaceWebAddress";
import { WORKSPACE_WEB_CHROME_STATE_CHANNEL } from "../src/shared/workspaceWebChrome";

const { invoke, send, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(async () => new Promise(() => {})),
  send: vi.fn(),
  listeners: new Map<string, (event: unknown, value: unknown) => void>()
}));
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
  ["https://user:secret@example.com", null], ["貓".repeat(300), null]
])("resolves %s", (input, expected) => {
  expect(resolveWorkspaceWebAddress(input)).toBe(expected);
});

for (const platform of ["macos", "windows"] as const) {
  describe(`${platform} Electron address integration`, () => {
    let registered: Array<[string, EventListenerOrEventListenerObject]> = [];
    beforeEach(async () => {
      registered = [];
      const add = window.addEventListener.bind(window);
      vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
        registered.push([type, listener]);
        add(type, listener, options);
      });
      vi.resetModules(); invoke.mockClear(); send.mockClear(); listeners.clear();
      document.body.innerHTML = new DOMParser().parseFromString(
        readFileSync("src/renderer/runtime-web-chrome-electron.html", "utf8"), "text/html"
      ).body.innerHTML;
      delete document.documentElement.dataset.theme;
      document.documentElement.style.colorScheme = "";
      await import("../src/electron/preload/workspaceWebChrome");
      window.dispatchEvent(new Event("DOMContentLoaded"));
    });
    afterEach(() => {
      for (const [type, listener] of registered) window.removeEventListener(type, listener);
      vi.restoreAllMocks();
    });
    const project = (url: string, resolvedTheme = "light", identity = { surfaceId: "surface-a", generation: 1 }, patch: Record<string, unknown> = {}) => {
      const state = { url, canGoBack: true, canGoForward: false, documentEpoch: 4, resolvedTheme };
      const { documentEpoch: _epoch, ...rest } = state;
      listeners.get(WORKSPACE_WEB_CHROME_STATE_CHANNEL)?.(null, {
        language: "en", labels: workspaceWebChromeCopy("en"), ...rest, ...identity, ...patch
      });
    };
    it("hydrates the latest projection when it arrives before the document is ready", () => {
      const markup = document.body.innerHTML;
      document.body.innerHTML = "";
      const labels = workspaceWebChromeCopy("ja");
      project("https://example.com/", "dark", undefined, { language: "ja", labels, loading: true });
      document.body.innerHTML = markup;
      window.dispatchEvent(new Event("DOMContentLoaded"));
      expect(document.querySelector<HTMLInputElement>("#location")?.value).toBe("example.com/");
      expect(document.querySelector<HTMLInputElement>("#location")?.disabled).toBe(false);
      expect(document.querySelector("#location-form")?.getAttribute("data-state")).toBe("loading");
      expect(document.querySelector("#reload")?.getAttribute("aria-label")).toBe(labels.reload);
    });
    it("selects only the first undragged mouse click, preserving later caret and drag selection", () => {
      project("https://www.example.com/start");
      const input = document.querySelector<HTMLInputElement>("#location")!;
      const down = () => input.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 10, clientY: 10 }));
      const click = (detail = 1) => input.dispatchEvent(new MouseEvent("click", { detail }));
      down(); input.focus(); input.setSelectionRange(5, 5); click();
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
      down(); input.setSelectionRange(8, 8); click();
      expect([input.selectionStart, input.selectionEnd]).toEqual([8, 8]);
      input.blur(); down(); input.focus();
      input.dispatchEvent(new MouseEvent("pointermove", { clientX: 40, clientY: 10 }));
      input.setSelectionRange(3, 7); click();
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
      down(); input.setSelectionRange(12, 19); click(2);
      expect([input.selectionStart, input.selectionEnd]).toEqual([12, 19]);
      expect(send).not.toHaveBeenCalled();
    });
    it("does not intercept Tab, application shortcuts, or ordinary input", () => {
      project("https://www.example.com/start");
      const input = document.querySelector<HTMLInputElement>("#location")!;
      input.focus();
      for (const init of [{ key: "Tab" }, { key: "Tab", shiftKey: true },
        { key: "l", metaKey: true }, { key: "l", ctrlKey: true }, { key: "a" }, { key: "F11" }]) {
        const event = new KeyboardEvent("keydown", { ...init, cancelable: true });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(send).not.toHaveBeenCalled();
    });
    it("prioritizes validation over failures and loading without losing the draft on navigation or language changes", () => {
      const url = "https://www.example.com/start";
      const input = document.querySelector<HTMLInputElement>("#location")!;
      const form = document.querySelector<HTMLFormElement>("#location-form")!;
      project(url, "light", undefined, { loading: true, statusText: "Loading…" });
      expect(form.dataset.state).toBe("loading");
      expect(document.querySelector("nav")?.getAttribute("aria-busy")).toBe("true");
      expect(document.querySelector<HTMLButtonElement>("#reload")?.disabled).toBe(false);
      input.focus(); input.value = "file:///draft";
      input.setSelectionRange(3, 7);
      form.dispatchEvent(new Event("submit", { cancelable: true }));
      expect(form.dataset.state).toBe("invalid");
      for (const language of ["zh-TW", "zh-CN", "ja", "en"] as const) {
        const labels = workspaceWebChromeCopy(language);
        project("https://www.example.com/redirect", "dark", undefined,
          { language, labels, loading: false, errorCode: -105, statusText: "Page could not load." });
        expect(form.dataset.state).toBe("invalid");
        expect(document.documentElement.lang).toBe(language);
        expect(document.querySelector("#home")?.getAttribute("aria-label")).toBe(labels.home);
        expect(input.placeholder).toBe(labels.placeholder);
        expect(input.title).toBe(labels.invalidAddress);
        expect(input.getAttribute("aria-invalid")).toBe("true");
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe("file:///draft");
        expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
      }
      input.value = "example.com"; input.dispatchEvent(new Event("input"));
      expect(form.dataset.state).toBe("failed");
      expect(input.hasAttribute("aria-invalid")).toBe(false);
      project(url, "light", undefined, { loading: true });
      expect(form.dataset.state).toBe("loading");
      project(url);
      expect(form.dataset.state).toBe("idle");
      expect(document.querySelector("#navigation-status")?.textContent).toBe("");
      expect(document.querySelector("nav")?.getAttribute("aria-busy")).toBe("false");
      input.blur();
      project("rion-start://home/");
      expect(form.dataset.state).toBe("home");
      expect(input.value).toBe("");
      input.focus(); form.dispatchEvent(new Event("submit", { cancelable: true }));
      expect(input.title).toBe(workspaceWebChromeCopy("en").emptyAddress);
      expect(send).not.toHaveBeenCalled();
    });
    it("keeps reload as reload while loading and follows back/forward availability", () => {
      project("https://example.com/", "light", undefined, { loading: true, canGoBack: false, canGoForward: true });
      expect(document.querySelector<HTMLButtonElement>("#back")?.disabled).toBe(true);
      expect(document.querySelector<HTMLButtonElement>("#forward")?.disabled).toBe(false);
      document.querySelector<HTMLButtonElement>("#reload")!.click();
      expect(send).toHaveBeenCalledWith(expect.any(String), { surfaceId: "surface-a", generation: 1, type: "reload" });
    });
    it("updates themes without changing an address draft, selection, focus or validation", () => {
      project("https://www.example.com/start", "dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.style.colorScheme).toBe("dark");
      const input = document.querySelector<HTMLInputElement>("#location")!;
      input.focus(); input.value = "file:///draft";
      input.setSelectionRange(3, 7);
      document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
      expect(input.getAttribute("aria-invalid")).toBe("true");
      project("https://www.example.com/start", "light");
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.style.colorScheme).toBe("light");
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("file:///draft");
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(send).not.toHaveBeenCalled();
    });
    it("ignores invalid themes and mismatched surface generations", () => {
      project("https://www.example.com/start", "light");
      project("https://www.example.com/start", "system");
      project("https://www.example.com/start", "dark", { surfaceId: "surface-other", generation: 1 });
      project("https://www.example.com/start", "dark", { surfaceId: "surface-a", generation: 2 });
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.style.colorScheme).toBe("light");
    });
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
      const action = send.mock.calls.at(-1);
      expect(JSON.stringify(action)).toContain("https://www.google.com/search?q=%E4%B8%AD%E6%96%87%20%26%20cats");
      invoke.mockClear(); send.mockClear(); input.value = "file:///tmp/x"; submit();
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(invoke).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    });
  });
}
