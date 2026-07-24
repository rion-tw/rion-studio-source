import { describe, expect, it, vi } from "vitest";

import {
  MACRO_OVERLAY_SCRIPT,
  MACRO_SHORTCUT_GUARD_SOURCE,
  MacroOverlayInjector,
  shouldIgnoreMacroShortcutEvent
} from "../src/main/macros/MacroOverlayInjector";
import type { CoreCommand, MacroOverlayViewModelRecord } from "../src/shared/generated";
import type { Role } from "../src/shared/types";
import { v1Case } from "./helpers/v1Parity";

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
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("30000");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("setInterval");
    expect(MACRO_SHORTCUT_GUARD_SOURCE).toContain("shouldIgnoreMacroShortcutEvent");
    v1Case("overlay-cd72ac236bea", () => {
      expect(() => new Function(MACRO_OVERLAY_SCRIPT)).not.toThrow();
      expect(MACRO_OVERLAY_SCRIPT).toContain('.trigger{');
      expect(MACRO_OVERLAY_SCRIPT).not.toContain('.panel{');
    });
    v1Case("overlay-35aaf25a722f", () => {
      expect(MACRO_OVERLAY_SCRIPT).toContain("retainedClickStatuses");
      expect(MACRO_OVERLAY_SCRIPT).not.toContain("reconciliationTimer");
    });
    v1Case("overlay-1ccbd5c6e796", () => {
      expect(() => new Function(`return ${MACRO_SHORTCUT_GUARD_SOURCE}`)).not.toThrow();
      expect(MACRO_SHORTCUT_GUARD_SOURCE).not.toContain("MACRO_");
    });
    v1Case("overlay-0408e2bea656", () => {
      expect(MACRO_OVERLAY_SCRIPT).toContain('class="action-menu" hidden role="menu"');
      expect(MACRO_OVERLAY_SCRIPT).toContain('class="coordinate-anchor-layer" hidden aria-hidden="true"');
      expect(MACRO_OVERLAY_SCRIPT).toContain('type: "copy-coordinate"');
    });
    v1Case("overlay-2e3447b9b20b", () => {
      expect(MACRO_OVERLAY_SCRIPT).toContain('triggerAria: "Open Rion Studio Macros"');
      expect(MACRO_OVERLAY_SCRIPT).toContain('triggerAria: "開啟 Rion Studio 巨集"');
      expect(MACRO_OVERLAY_SCRIPT).toContain('triggerAria: "Rion Studio マクロを開く"');
      expect(MACRO_OVERLAY_SCRIPT).toContain('class="active-badge-name"');
      expect(MACRO_OVERLAY_SCRIPT).toContain('class="active-badge-shortcut"');
    });
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
    v1Case("overlay-068660b5b0d8", () => {
      expect(page.executeJavaScript).toHaveBeenCalledWith(MACRO_OVERLAY_SCRIPT);
    });
    v1Case("overlay-fd623ce16ea6", () => {
      expect(page.executeJavaScript).toHaveBeenCalledTimes(3);
      expect(page.on).toHaveBeenCalledTimes(3);
    });
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

    await expect(
      injector.handleEmbeddedRequest(page.webContents, role.id, {
        type: "release",
        macroId: "macro-1",
        pressId: "press-1"
      })
    ).resolves.toEqual(viewModel);

    v1Case("overlay-cfb034596b02", () => {
      expect(core.invoke).toHaveBeenNthCalledWith(2, {
        type: "overlayRequest",
        roleId: role.id,
        requestJson: JSON.stringify({
          type: "press",
          macroId: "macro-1",
          pressId: "press-1"
        }),
        language: "zh-TW"
      });
      expect(core.invoke).toHaveBeenNthCalledWith(3, {
        type: "overlayRequest",
        roleId: role.id,
        requestJson: JSON.stringify({
          type: "release",
          macroId: "macro-1",
          pressId: "press-1"
        }),
        language: "zh-TW"
      });
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
    v1Case("overlay-1692c43f8829", () => {
      expect(core.invoke).not.toHaveBeenCalled();
    });
  });

  it("rejects untracked views and role-handle mismatches before entering Rust", async () => {
    const page = createPage();
    const other = createPage();
    const core = createCore();
    const injector = new MacroOverlayInjector(core.client);
    await injector.install(role, page.webContents);

    await expect(
      injector.handleEmbeddedRequest(other.webContents, role.id, { type: "list" })
    ).rejects.toThrow("not associated with a role");
    await expect(
      injector.handleEmbeddedRequest(page.webContents, "role-2", { type: "list" })
    ).rejects.toThrow("different role");
    v1Case("overlay-7306a30fa890", () => {
      expect(core.invoke).not.toHaveBeenCalled();
    });
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
    v1Case("overlay-9221080af380", () => {
      expect(first.executeJavaScript).not.toHaveBeenCalled();
      expect(second.executeJavaScript).toHaveBeenCalledTimes(1);
    });
  });

  it("coalesces embedded refreshes and drops invalid trailing work", async () => {
    const first = createPage();
    const firstRefresh = createDeferred<void>();
    const injector = new MacroOverlayInjector(createCore().client);
    await injector.install(role, first.webContents);
    first.executeJavaScript.mockReset()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValue(undefined);

    injector.refreshInstalledOverlays(role.id);
    injector.refreshInstalledOverlays(role.id);
    injector.refreshInstalledOverlays(role.id);
    expect(first.executeJavaScript).toHaveBeenCalledTimes(1);
    firstRefresh.resolve();
    await vi.waitFor(() => expect(first.executeJavaScript).toHaveBeenCalledTimes(2));
    v1Case("overlay-8e7785078d85", () => {
      expect(first.executeJavaScript).toHaveBeenCalledTimes(2);
    });

    const destroyedPage = createPage();
    const destroyedRefresh = createDeferred<void>();
    await injector.install({ ...role, id: "role-destroyed" }, destroyedPage.webContents);
    destroyedPage.executeJavaScript.mockReset()
      .mockImplementationOnce(() => destroyedRefresh.promise)
      .mockResolvedValue(undefined);
    injector.refreshInstalledOverlays("role-destroyed");
    injector.refreshInstalledOverlays("role-destroyed");
    destroyedPage.destroyed?.();
    destroyedRefresh.resolve();
    await Promise.resolve();
    await Promise.resolve();
    v1Case("overlay-ab7d2a2856a4", () => {
      expect(destroyedPage.executeJavaScript).toHaveBeenCalledTimes(1);
    });

    const failedPage = createPage();
    const failedRefresh = createDeferred<void>();
    await injector.install({ ...role, id: "role-failed" }, failedPage.webContents);
    failedPage.executeJavaScript.mockReset()
      .mockImplementationOnce(() => failedRefresh.promise)
      .mockResolvedValue(undefined);
    injector.refreshInstalledOverlays("role-failed");
    injector.refreshInstalledOverlays("role-failed");
    failedPage.didFailLoad?.({}, -2, "failed", "https://example.com/play", true);
    failedRefresh.resolve();
    await Promise.resolve();
    await Promise.resolve();
    v1Case("overlay-08fd13347bff", () => {
      expect(failedPage.executeJavaScript).toHaveBeenCalledTimes(1);
    });
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
    v1Case("overlay-30e0b65eb973", () => {
      expect(core.invoke).toHaveBeenCalledTimes(2);
      expect(core.invoke).toHaveBeenCalledWith({
        type: "macroReleaseRole",
        roleId: role.id
      });
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

  it("disposes page-owned caches and rejects late navigation refreshes", async () => {
    const page = createPage();
    const injector = new MacroOverlayInjector(createCore().client);
    await injector.install(role, page.webContents);
    page.executeJavaScript.mockClear();

    await injector.dispose();
    page.didFinishLoad?.();
    injector.refreshInstalledOverlays();
    await Promise.resolve();

    expect(page.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(page.executeJavaScript).toHaveBeenCalledWith(
      "void window.__rionStudioMacroOverlay?.dispose?.()"
    );
    await expect(injector.install(role, page.webContents)).resolves.toBeUndefined();
    expect(page.executeJavaScript).toHaveBeenCalledTimes(1);
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
    v1Case("overlay-191698f6ef33", () => {
      expect(shouldIgnoreMacroShortcutEvent(event)).toBe(true);
      expect(shouldIgnoreMacroShortcutEvent({ ...event, defaultPrevented: true })).toBe(true);
      expect(shouldIgnoreMacroShortcutEvent({ ...event, isComposing: true })).toBe(true);
    });
    for (const [name, caseId] of [
      ["input", "overlay-f355b37ab593"],
      ["textarea", "overlay-ca4539a18e7d"],
      ["select", "overlay-6c2c56aaefc0"]
    ] as const) {
      const element = { localName: name };
      const candidate = { ...event, composedPath: () => [element], target: element };
      if (caseId === "overlay-f355b37ab593") {
        v1Case("overlay-f355b37ab593", () => {
          expect(shouldIgnoreMacroShortcutEvent(candidate)).toBe(true);
        });
      } else if (caseId === "overlay-ca4539a18e7d") {
        v1Case("overlay-ca4539a18e7d", () => {
          expect(shouldIgnoreMacroShortcutEvent(candidate)).toBe(true);
        });
      } else {
        v1Case("overlay-6c2c56aaefc0", () => {
          expect(shouldIgnoreMacroShortcutEvent(candidate)).toBe(true);
        });
      }
    }
    const editableAncestor = {
      getAttribute: (name: string) => name === "contenteditable" ? "true" : null,
      localName: "div"
    };
    const editableChild = { localName: "span", parentElement: editableAncestor };
    v1Case("overlay-c572ad820a1d", () => {
      expect(shouldIgnoreMacroShortcutEvent({
        ...event,
        composedPath: () => [editableChild],
        target: editableChild
      })).toBe(true);
    });
    const shadowInput = { localName: "input" };
    const shadowHost = { localName: "game-shell", shadowRoot: { activeElement: shadowInput } };
    v1Case("overlay-f24f2a325cdb", () => {
      expect(shouldIgnoreMacroShortcutEvent({
        ...event,
        composedPath: () => [],
        target: {}
      }, shadowHost)).toBe(true);
    });
    v1Case("overlay-70551c0c035a", () => {
      expect(shouldIgnoreMacroShortcutEvent({
        ...event,
        composedPath: () => [],
        target: { localName: "canvas" }
      })).toBe(false);
    });
    v1Case("overlay-fb57f69bf526", () => {
      const guardIndex = MACRO_OVERLAY_SCRIPT.indexOf("shouldIgnoreMacroShortcutEvent");
      const refreshIndex = MACRO_OVERLAY_SCRIPT.indexOf("refresh");
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(refreshIndex).toBeGreaterThan(guardIndex);
    });
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
  let didFailLoad:
    | ((
      event: unknown,
      errorCode: number,
      errorDescription: string,
      url: string,
      isMainFrame: boolean
    ) => void)
    | undefined;
  let didStartNavigation:
    | ((_event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void)
    | undefined;
  let destroyed: (() => void) | undefined;
  const executeJavaScript = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "did-finish-load") didFinishLoad = listener;
    if (event === "did-fail-load") didFailLoad = listener as typeof didFailLoad;
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
    get didFailLoad() {
      return didFailLoad;
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
