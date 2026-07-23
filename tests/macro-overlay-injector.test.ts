import { describe, expect, it, vi } from "vitest";

import {
  MACRO_OVERLAY_SCRIPT,
  MACRO_SHORTCUT_GUARD_SOURCE,
  MacroOverlayInjector,
  shouldIgnoreMacroShortcutEvent
} from "../src/main/macros/MacroOverlayInjector";
import type { CoreCommand, MacroOverlayViewModelRecord } from "../src/shared/generated";
import type { Role } from "../src/shared/types";

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  notes: "",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const viewModel: MacroOverlayViewModelRecord = {
  cpuThrottleRate: 2,
  detached: false,
  language: "zh-TW",
  macroBadgePosition: {
    horizontalAlign: "right",
    horizontalMarginPx: 16,
    topPx: 128
  },
  macros: [],
  resourceState: "throttled",
  statuses: []
};

describe("MacroOverlayInjector", () => {
  it("assembles executable raw runtime, shortcut guard, and presentation-only styles", () => {
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("__RION_STUDIO_MACRO_OVERLAY_CSS__");
    expect(MACRO_OVERLAY_SCRIPT).toContain('const overlayCss = "*{box-sizing:border-box');
    expect(MACRO_OVERLAY_SCRIPT).toContain("retainedClickStatuses");
    expect(MACRO_OVERLAY_SCRIPT).toContain("clickStatusRetentionTimer");
    expect(MACRO_OVERLAY_SCRIPT).toContain("}, 30000)");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("setInterval");
    expect(MACRO_SHORTCUT_GUARD_SOURCE).toContain("shouldIgnoreMacroShortcutEvent");
    expect(() => new Function(MACRO_OVERLAY_SCRIPT)).not.toThrow();
  });

  it("installs once per embedded handle and reinstalls after navigation", async () => {
    const page = createPage();
    const core = createCore();
    const injector = new MacroOverlayInjector(core.client);

    await injector.install(role, page.webContents);
    await injector.install(role, page.webContents);
    page.didFinishLoad?.();

    await vi.waitFor(() => {
      expect(page.executeJavaScript).toHaveBeenCalledTimes(3);
    });
    expect(page.executeJavaScript).toHaveBeenNthCalledWith(1, MACRO_OVERLAY_SCRIPT);
    expect(page.on).toHaveBeenCalledTimes(2);
  });

  it("forwards a raw embedded request to the typed Rust overlay command", async () => {
    const page = createPage();
    const core = createCore(viewModel);
    const injector = new MacroOverlayInjector(core.client);
    await injector.install(role, page.webContents);
    await injector.setLanguage("zh-TW");

    await expect(
      injector.handleEmbeddedRequest(page.webContents, role.id, {
        type: "press",
        macroId: "macro-1",
        pressId: "press-1"
      })
    ).resolves.toEqual(viewModel);

    expect(core.invoke).toHaveBeenCalledWith({
      type: "overlayRequest",
      roleId: role.id,
      requestJson: JSON.stringify({
        type: "press",
        macroId: "macro-1",
        pressId: "press-1"
      }),
      language: "zh-TW"
    });
  });

  it("keeps stale Electron handles detached without issuing a Rust operation", async () => {
    const page = createPage();
    const core = createCore();
    const injector = new MacroOverlayInjector(core.client);
    await injector.install(role, page.webContents);
    core.invoke.mockClear();

    await expect(
      injector.handleEmbeddedRequest(page.webContents, undefined, { type: "open" })
    ).resolves.toEqual({
      detached: true,
      language: undefined,
      macros: [],
      statuses: []
    });
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("rejects untracked views and role-handle mismatches before entering Rust", async () => {
    const page = createPage();
    const other = createPage();
    const injector = new MacroOverlayInjector(createCore().client);
    await injector.install(role, page.webContents);

    await expect(
      injector.handleEmbeddedRequest(other.webContents, role.id, { type: "list" })
    ).rejects.toThrow("not associated with a role");
    await expect(
      injector.handleEmbeddedRequest(page.webContents, "role-2", { type: "list" })
    ).rejects.toThrow("different role");
  });

  it("refreshes only selected embedded handles without a TypeScript queue or timer", async () => {
    const first = createPage();
    const second = createPage();
    const injector = new MacroOverlayInjector(createCore().client);
    await injector.install(role, first.webContents);
    await injector.install({ ...role, id: "role-2" }, second.webContents);
    first.executeJavaScript.mockClear();
    second.executeJavaScript.mockClear();

    injector.refreshInstalledOverlays(["role-2"]);

    await vi.waitFor(() => {
      expect(second.executeJavaScript).toHaveBeenCalledWith(
        "void window.__rionStudioMacroOverlay?.refresh?.()"
      );
    });
    expect(first.executeJavaScript).not.toHaveBeenCalled();
  });

  it("releases Rust-owned held input on main-frame navigation and destroyed handles", async () => {
    const page = createPage();
    const core = createCore();
    const injector = new MacroOverlayInjector(core.client);
    await injector.install(role, page.webContents);
    core.invoke.mockClear();

    page.didStartNavigation?.({}, "https://example.com/frame", false, false);
    expect(core.invoke).not.toHaveBeenCalled();

    page.didStartNavigation?.({}, "https://example.com/next", false, true);
    page.destroyed?.();
    expect(core.invoke).toHaveBeenCalledTimes(2);
    expect(core.invoke).toHaveBeenCalledWith({
      type: "macroReleaseRole",
      roleId: role.id
    });
  });

  it("forwards overlay language to Rust and refreshes installed pages after acknowledgement", async () => {
    const page = createPage();
    const core = createCore();
    const injector = new MacroOverlayInjector(core.client);
    await injector.install(role, page.webContents);
    page.executeJavaScript.mockClear();

    await injector.setLanguage("ja");

    expect(core.invoke).toHaveBeenCalledWith({ type: "overlayLanguageSet", language: "ja" });
    expect(page.executeJavaScript).toHaveBeenCalledWith(
      "void window.__rionStudioMacroOverlay?.refresh?.()"
    );
  });
});

describe("macro overlay shortcut presentation guard", () => {
  it("ignores editable and IME events but permits game-surface shortcuts", () => {
    const editable = {
      getAttribute: (name: string) => name === "role" ? "textbox" : null,
      localName: "div"
    };
    const event = {
      composedPath: () => [editable],
      defaultPrevented: false,
      isComposing: false,
      key: "a",
      keyCode: 65,
      target: editable
    };
    expect(shouldIgnoreMacroShortcutEvent(event)).toBe(true);
    expect(shouldIgnoreMacroShortcutEvent({ ...event, composedPath: () => [], target: {} }))
      .toBe(false);
    expect(shouldIgnoreMacroShortcutEvent({ ...event, isComposing: true }))
      .toBe(true);
  });
});

function createCore(result: MacroOverlayViewModelRecord = viewModel) {
  const invoke = vi.fn(async (command: CoreCommand) => {
    if (command.type === "overlayRequest") return result;
    return { ok: true };
  });
  return {
    invoke,
    client: {
      invoke: invoke
    } as never
  };
}

function createPage() {
  let didFinishLoad: (() => void) | undefined;
  let didStartNavigation:
    | ((_event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void)
    | undefined;
  let destroyed: (() => void) | undefined;
  const executeJavaScript = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "did-finish-load") didFinishLoad = listener;
    if (event === "did-start-navigation") {
      didStartNavigation = listener as typeof didStartNavigation;
    }
  });
  const once = vi.fn((event: string, listener: () => void) => {
    if (event === "destroyed") destroyed = listener;
  });
  return {
    executeJavaScript,
    get didFinishLoad() {
      return didFinishLoad;
    },
    get didStartNavigation() {
      return didStartNavigation;
    },
    get destroyed() {
      return destroyed;
    },
    on,
    webContents: {
      executeJavaScript,
      isDestroyed: vi.fn(() => false),
      on,
      once
    } as never
  };
}
