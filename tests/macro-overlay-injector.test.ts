import { runInNewContext } from "node:vm";

import { describe, expect, it, vi, type Mock } from "vitest";

import {
  MACRO_SHORTCUT_GUARD_SOURCE,
  MACRO_OVERLAY_SCRIPT,
  MacroOverlayInjector,
  shouldIgnoreMacroShortcutEvent,
  type MacroOverlayRequest
} from "../src/main/macros/MacroOverlayInjector";
import type { Macro, MacroRunStatus, Role, RoleStatus } from "../src/shared/types";

type AnyMock = Mock;

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  windowWidth: 1280,
  windowHeight: 720,
  notes: "",
  authState: "authenticated",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const assignedMacro: Macro = {
  id: "macro-1",
  enabled: true,
  name: "Auto heal",
  roleIds: ["role-1", "role-2"],
  trigger: { code: "F2", ctrl: false, alt: false, shift: false, meta: false },
  repeat: { type: "once" },
  steps: [{ id: "step-1", type: "key", code: "F2" }],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const otherMacro: Macro = {
  ...assignedMacro,
  id: "macro-2",
  name: "Other",
  roleIds: ["role-2"]
};

describe("MacroOverlayInjector", () => {
  it("assembles executable raw runtime, shortcut guard, and minimal overlay styles", () => {
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("__RION_STUDIO_MACRO_OVERLAY_CSS__");
    expect(MACRO_OVERLAY_SCRIPT).toContain('const overlayCss = "*{box-sizing:border-box');
    expect(MACRO_OVERLAY_SCRIPT).toContain('.trigger{');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('.panel{');
    expect(() => new Function(MACRO_OVERLAY_SCRIPT)).not.toThrow();
  });

  it("installs the overlay script into embedded web contents", async () => {
    const page = createPage();
    const injector = createInjector();

    await injector.install(role, page.page as never);

    expect(page.page.executeJavaScript).toHaveBeenCalledWith(MACRO_OVERLAY_SCRIPT);
  });

  it("installs and routes the same overlay in external Chrome", async () => {
    let requestHandler: ((request: unknown) => Promise<unknown>) | undefined;
    const host = {
      evaluate: vi.fn().mockResolvedValue(undefined),
      installMacroOverlay: vi.fn(async (_source: string, handler: (request: unknown) => Promise<unknown>) => {
        requestHandler = handler;
      }),
      onDisconnect: vi.fn(() => () => undefined)
    };
    const macroManager = {
      listStatuses: vi.fn(() => []),
      start: vi.fn().mockResolvedValue([]),
      stop: vi.fn().mockResolvedValue(undefined)
    };
    const onMacroPageRequested = vi.fn();
    const injector = createInjector({ macroManager, onMacroPageRequested });

    await injector.installExternal(role, host);
    expect(host.installMacroOverlay).toHaveBeenCalledWith(MACRO_OVERLAY_SCRIPT, expect.any(Function));
    await expect(requestHandler?.({ type: "start", macroId: assignedMacro.id })).resolves.toMatchObject({
      macros: [{ id: assignedMacro.id }]
    });
    await requestHandler?.({ type: "open" });
    await expect(requestHandler?.({ type: "unknown" })).rejects.toThrow("Invalid macro overlay request");
    await expect(requestHandler?.({
      type: "release",
      macroId: assignedMacro.id,
      pressId: "press-1",
      releaseMode: "later"
    })).rejects.toThrow("Invalid macro overlay request");
    expect(macroManager.start).toHaveBeenCalledWith(assignedMacro.id);
    expect(onMacroPageRequested).toHaveBeenCalledWith({ roleId: role.id });

    injector.refreshInstalledOverlays(role.id);
    await vi.waitFor(() =>
      expect(host.evaluate).toHaveBeenCalledWith("window.__rionStudioMacroOverlay?.refresh?.()")
    );
  });

  it("reinstalls after navigation and keeps event setup idempotent", async () => {
    const page = createPage();
    const injector = createInjector();

    await injector.install(role, page.page as never);
    await injector.install(role, page.page as never);
    page.handlers.didFinishLoad?.();

    await vi.waitFor(() => expect(page.page.executeJavaScript).toHaveBeenCalledTimes(3));
    expect(page.page.on).toHaveBeenCalledTimes(2);
  });

  it("releases held shortcuts only for main-frame embedded navigation", async () => {
    const page = createPage();
    const releaseAll = vi.fn().mockResolvedValue(undefined);
    const injector = createInjector({
      macroManager: {
        listStatuses: vi.fn(() => []),
        releaseAll,
        start: vi.fn().mockResolvedValue([]),
        stop: vi.fn().mockResolvedValue(undefined)
      }
    });

    await injector.install(role, page.page as never);
    page.handlers.didStartNavigation?.({}, "https://example.com/frame", false, false);
    expect(releaseAll).not.toHaveBeenCalled();
    page.handlers.didStartNavigation?.({}, "https://example.com/next", false, true);
    expect(releaseAll).toHaveBeenCalledWith(role.id);
  });

  it("filters overlay state and routes start and stop requests", async () => {
    const page = createPage();
    const statuses: MacroRunStatus[] = [
      runStatus("role-1", "macro-1"),
      runStatus("role-2", "macro-1"),
      runStatus("role-2", "macro-2")
    ];
    const macroManager = {
      listStatuses: vi.fn(() => statuses),
      start: vi.fn().mockResolvedValue([statuses[0]]),
      stop: vi.fn().mockResolvedValue(undefined)
    };
    const injector = createInjector({
      macroManager,
      getRoleStatus: () => ({
        roleId: role.id,
        state: "running",
        resourceState: "throttled",
        cpuThrottleRate: 2
      })
    });

    await injector.install(role, page.page as never);
    injector.setLanguage("zh-TW");
    const listState = await injector.handleEmbeddedRequest(page.page as never, role.id, { type: "list" });
    const startState = await injector.handleEmbeddedRequest(
      page.page as never,
      role.id,
      { type: "start", macroId: assignedMacro.id }
    );
    await injector.handleEmbeddedRequest(
      page.page as never,
      role.id,
      { type: "stop", macroId: assignedMacro.id }
    );

    expect(listState).toMatchObject({
      language: "zh-TW",
      resourceState: "throttled",
      cpuThrottleRate: 2,
      macros: [{ id: assignedMacro.id }],
      statuses: [
        { roleId: "role-1", macroId: assignedMacro.id },
        { roleId: "role-2", macroId: assignedMacro.id }
      ]
    });
    expect(startState).toMatchObject({
      startSummary: { skippedCount: 1, startedCount: 1 }
    });
    macroManager.start.mockResolvedValueOnce([statuses[0], statuses[1]]);
    await expect(
      injector.handleRequest(role.id, { type: "start", macroId: assignedMacro.id })
    ).resolves.toMatchObject({ startSummary: { skippedCount: 0, startedCount: 2 } });
    expect(macroManager.start).toHaveBeenCalledWith(assignedMacro.id);
    expect(macroManager.stop).toHaveBeenCalledWith(assignedMacro.id);
  });

  it("routes matching while-held press and release ids", async () => {
    const press = vi.fn().mockResolvedValue([runStatus("role-1", assignedMacro.id)]);
    const release = vi.fn().mockResolvedValue(undefined);
    const injector = createInjector({
      macroManager: {
        listStatuses: vi.fn(() => []),
        press,
        release,
        start: vi.fn().mockResolvedValue([]),
        stop: vi.fn().mockResolvedValue(undefined)
      }
    });

    await expect(injector.handleRequest(role.id, {
      type: "press",
      macroId: assignedMacro.id,
      pressId: "press-1"
    })).resolves.toMatchObject({ startSummary: { startedCount: 1 } });
    await injector.handleRequest(role.id, {
      type: "release",
      macroId: assignedMacro.id,
      pressId: "press-1",
      releaseMode: "complete_first_iteration"
    });

    expect(press).toHaveBeenCalledWith(assignedMacro.id, role.id, "press-1");
    expect(release).toHaveBeenCalledWith(
      assignedMacro.id,
      role.id,
      "press-1",
      "complete_first_iteration"
    );
  });

  it("returns a detached state without side effects for every stale request", async () => {
    const page = createPage();
    const listMacros = vi.fn().mockResolvedValue([assignedMacro]);
    const listStatuses = vi.fn(() => []);
    const startForRole = vi.fn();
    const stopForRole = vi.fn();
    const onMacroPageRequested = vi.fn();
    const injector = new MacroOverlayInjector(
      { listMacros },
      { listStatuses, startForRole, stopForRole },
      onMacroPageRequested
    );
    const requests = [
      { type: "list" },
      { type: "open" },
      { type: "start", macroId: assignedMacro.id },
      { type: "stop", macroId: assignedMacro.id }
    ] satisfies MacroOverlayRequest[];

    await injector.install(role, page.page as never);
    for (const request of requests) {
      await expect(
        injector.handleEmbeddedRequest(page.page as never, undefined, request)
      ).resolves.toMatchObject({ detached: true, macros: [], statuses: [] });
    }

    expect(listMacros).not.toHaveBeenCalled();
    expect(listStatuses).not.toHaveBeenCalled();
    expect(startForRole).not.toHaveBeenCalled();
    expect(stopForRole).not.toHaveBeenCalled();
    expect(onMacroPageRequested).not.toHaveBeenCalled();
  });

  it("rejects untracked embedded views and active role mismatches", async () => {
    const page = createPage();
    const untrackedPage = createPage();
    const injector = createInjector();

    await injector.install(role, page.page as never);

    await expect(
      injector.handleEmbeddedRequest(untrackedPage.page as never, role.id, { type: "list" })
    ).rejects.toThrow("Embedded game view is not associated with a role.");
    await expect(
      injector.handleEmbeddedRequest(page.page as never, "role-2", { type: "open" })
    ).rejects.toThrow("Embedded game view is associated with a different role.");
  });

  it("rejects start and stop requests for macros not assigned to the overlay role", async () => {
    const macroManager = {
      listStatuses: vi.fn(() => []),
      start: vi.fn().mockResolvedValue([]),
      stop: vi.fn().mockResolvedValue(undefined)
    };
    const injector = createInjector({ macroManager });

    for (const type of ["start", "stop"] as const) {
      await expect(injector.handleRequest(role.id, { type, macroId: otherMacro.id })).rejects.toThrow(
        "This macro is not assigned to the current role."
      );
    }

    expect(macroManager.start).not.toHaveBeenCalled();
    expect(macroManager.stop).not.toHaveBeenCalled();
  });

  it("opens the macro page for the installed role", async () => {
    const page = createPage();
    const onMacroPageRequested = vi.fn();
    const injector = createInjector({ onMacroPageRequested });

    await injector.install(role, page.page as never);
    await injector.handleEmbeddedRequest(page.page as never, role.id, { type: "open" });

    expect(onMacroPageRequested).toHaveBeenCalledOnce();
    expect(onMacroPageRequested).toHaveBeenCalledWith({ roleId: role.id });
  });

  it("captures statuses after an asynchronous macro list finishes", async () => {
    const macros = createDeferred<Macro[]>();
    let statuses: MacroRunStatus[] = [];
    const injector = new MacroOverlayInjector(
      { listMacros: vi.fn(() => macros.promise) },
      {
        listStatuses: vi.fn(() => statuses),
        startForRole: vi.fn(),
        stopForRole: vi.fn()
      }
    );

    const state = injector.handleRequest(role.id, { type: "list" });
    statuses = [runStatus(role.id, assignedMacro.id)];
    macros.resolve([assignedMacro]);

    await expect(state).resolves.toMatchObject({ statuses: [{ state: "running" }] });
  });

  it("can proactively refresh installed overlay pages", async () => {
    const page = createPage();
    const injector = createInjector();

    await injector.install(role, page.page as never);
    injector.refreshInstalledOverlays(role.id);

    await vi.waitFor(() =>
      expect(page.page.executeJavaScript).toHaveBeenCalledWith(
        "window.__rionStudioMacroOverlay?.refresh?.()"
      )
    );
  });

  it("keeps a stable trigger while removing the action menu and focus restoration", () => {
    expect(MACRO_OVERLAY_SCRIPT).toContain('const hostId = "rion-studio-macro-overlay-v32"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('const scriptVersion = "2026-07-18.1"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('case "primary"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('root.innerHTML = [');
    expect(MACRO_OVERLAY_SCRIPT).toContain('await binding({ type: "open" });');
    expect(MACRO_OVERLAY_SCRIPT).toContain('event.code === "KeyM"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("event.code === trigger.code");
    expect(MACRO_OVERLAY_SCRIPT).toContain("const pendingMacroActions = new Set()");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function disposeIfDetached(nextState)");
    expect(MACRO_OVERLAY_SCRIPT).toContain('triggerElement?.addEventListener("pointerdown"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('triggerElement?.addEventListener("mousedown"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('triggerElement?.addEventListener("click"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="active-badges" aria-hidden="true"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('class="panel"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("macro-enabled-switch");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("macro-edit");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("macro-row");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('type: "create"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('type: "edit"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('type: "set-enabled"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("focusAutomationTarget");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("document.activeElement === element");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('querySelectorAll("canvas");');
  });

  it("localizes the open action and renders passive running badges", () => {
    expect(MACRO_OVERLAY_SCRIPT).toContain('triggerAria: "Open Rion Studio Macros"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('triggerAria: "開啟 Rion Studio 巨集"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('triggerAria: "打开 Rion Studio 宏"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('triggerAria: "Rion Studio マクロを開く"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("function getRunningBadgeMacros()");
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      "return state.macros.filter((macro) => macro.enabled !== false && isRunning(macro.id));"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="active-badge-name"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="active-badge-shortcut"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("left:50%");
    expect(MACRO_OVERLAY_SCRIPT).toContain("top:20%");
    expect(MACRO_OVERLAY_SCRIPT).toContain("pointer-events:none;position:fixed");
  });
});

describe("macro shortcut editable guard", () => {
  it("allows page-handled events while ignoring IME composition and editable documents", () => {
    const body = createElementStub("body");

    expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ defaultPrevented: true }), body)).toBe(false);
    expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ isComposing: true }), body)).toBe(true);
    expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ key: "Process" }), body)).toBe(true);
    expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ keyCode: 229 }), body)).toBe(true);
    expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub(), body, "ON")).toBe(true);
  });

  it.each(["input", "textarea", "select"])("ignores events from %s elements", (localName) => {
    const element = createElementStub(localName);
    expect(
      shouldIgnoreMacroShortcutEvent(
        createKeyboardEventStub({ composedPath: () => [element], target: element }),
        createElementStub("body")
      )
    ).toBe(true);
  });

  it("recognizes contenteditable and editable ARIA ancestors", () => {
    const contentEditable = createElementStub("div", { attributes: { contenteditable: "plaintext-only" } });
    const contentChild = createElementStub("span", { parentElement: contentEditable });
    const ariaTextbox = createElementStub("div", { attributes: { role: "presentation TEXTBOX" } });
    const ariaChild = createElementStub("span", { parentElement: ariaTextbox });

    expect(
      shouldIgnoreMacroShortcutEvent(
        createKeyboardEventStub({ composedPath: () => [contentChild], target: contentChild })
      )
    ).toBe(true);
    expect(
      shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ composedPath: () => [ariaChild], target: ariaChild }))
    ).toBe(true);

    for (const editableRole of ["searchbox", "combobox", "spinbutton"]) {
      const element = createElementStub("div", { attributes: { role: editableRole } });
      expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ target: element }))).toBe(true);
    }
  });

  it("uses active element and open shadow-root focus as fallbacks", () => {
    const input = createElementStub("input");
    const shadowHost = createElementStub("game-chat", { shadowActiveElement: input });
    const canvas = createElementStub("canvas");

    expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ target: canvas }), input)).toBe(true);
    expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ target: canvas }), shadowHost)).toBe(true);
  });

  it("allows shortcuts from non-editable game surfaces", () => {
    const body = createElementStub("body");
    const canvas = createElementStub("canvas");
    const nonEditable = createElementStub("div", {
      attributes: { contenteditable: "false", role: "button" },
      parentElement: body
    });

    expect(
      shouldIgnoreMacroShortcutEvent(
        createKeyboardEventStub({ composedPath: () => [canvas, body], target: canvas }),
        body,
        "off"
      )
    ).toBe(false);
    expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ target: nonEditable }), body)).toBe(false);
  });

  it("serializes the production guard without module-scope dependencies", () => {
    const serializedGuard = runInNewContext(MACRO_SHORTCUT_GUARD_SOURCE) as typeof shouldIgnoreMacroShortcutEvent;
    const input = createElementStub("input");
    const canvas = createElementStub("canvas");

    expect(serializedGuard(createKeyboardEventStub({ target: input }), input)).toBe(true);
    expect(serializedGuard(createKeyboardEventStub({ target: canvas }), canvas)).toBe(false);
  });

  it("runs the editable guard before refresh, open, and macro matching", () => {
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      `const shouldIgnoreShortcutEvent = ${MACRO_SHORTCUT_GUARD_SOURCE};`
    );
    const handler = MACRO_OVERLAY_SCRIPT.slice(
      MACRO_OVERLAY_SCRIPT.indexOf("function handleKeyDown(event)"),
      MACRO_OVERLAY_SCRIPT.indexOf("function handleFocus()")
    );
    const guardIndex = handler.indexOf("shouldIgnoreShortcutEvent(event, undefined, document.designMode)");

    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(handler.indexOf("refreshIfStale()"));
    expect(guardIndex).toBeLessThan(handler.indexOf("matchesOpenShortcut(event)"));
    expect(guardIndex).toBeLessThan(handler.indexOf("matchesShortcut(event, macro.trigger)"));
    expect(guardIndex).toBeLessThan(handler.indexOf("consumeShortcutEvent(event)"));
  });
});

function createInjector({
  getRoleStatus,
  macroManager = {
    listStatuses: vi.fn(() => []),
    start: vi.fn().mockResolvedValue([]),
    stop: vi.fn().mockResolvedValue(undefined)
  },
  onMacroPageRequested
}: {
  macroManager?: {
    listStatuses: AnyMock;
    press?: AnyMock;
    release?: AnyMock;
    releaseAll?: AnyMock;
    start: AnyMock;
    stop: AnyMock;
  };
  getRoleStatus?: (roleId: string) => RoleStatus | undefined;
  onMacroPageRequested?: AnyMock;
} = {}): MacroOverlayInjector {
  const roleAwareMacroManager = {
    listStatuses: macroManager.listStatuses,
    pressForRole: macroManager.press,
    releaseForRole: macroManager.release,
    releaseHeldTriggersForRole: macroManager.releaseAll,
    startForRole: vi.fn((macroId: string, roleId: string) => {
      if (![assignedMacro, otherMacro].find((macro) => macro.id === macroId)?.roleIds.includes(roleId)) {
        throw new Error("This macro is not assigned to the current role.");
      }
      return macroManager.start(macroId);
    }),
    stopForRole: vi.fn((macroId: string, roleId: string) => {
      if (![assignedMacro, otherMacro].find((macro) => macro.id === macroId)?.roleIds.includes(roleId)) {
        throw new Error("This macro is not assigned to the current role.");
      }
      return macroManager.stop(macroId);
    })
  };
  return new MacroOverlayInjector(
    { listMacros: vi.fn().mockResolvedValue([assignedMacro, otherMacro]) },
    roleAwareMacroManager,
    onMacroPageRequested,
    getRoleStatus
  );
}

function runStatus(roleId: string, macroId: string): MacroRunStatus {
  return {
    roleId,
    macroId,
    state: "running",
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
}

function createPage() {
  const handlers: {
    didFinishLoad?: () => void;
    didStartNavigation?: (
      event: unknown,
      url: string,
      isInPlace: boolean,
      isMainFrame: boolean
    ) => void;
  } = {};
  const page = {
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      if (event === "did-finish-load") handlers.didFinishLoad = handler;
      if (event === "did-start-navigation") {
        handlers.didStartNavigation = handler as typeof handlers.didStartNavigation;
      }
    }),
    once: vi.fn()
  };
  return { handlers, page };
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

interface ElementStubOptions {
  attributes?: Record<string, string>;
  isContentEditable?: boolean;
  parentElement?: ElementStub;
  rootHost?: ElementStub;
  shadowActiveElement?: ElementStub;
}

interface ElementStub {
  getAttribute(name: string): string | null;
  getRootNode(): { host?: ElementStub };
  isContentEditable: boolean;
  localName: string;
  parentElement?: ElementStub;
  shadowRoot?: { activeElement?: ElementStub };
}

function createElementStub(localName: string, options: ElementStubOptions = {}): ElementStub {
  const attributes = new Map(Object.entries(options.attributes ?? {}));
  return {
    getAttribute: (name) => attributes.get(name) ?? null,
    getRootNode: () => ({ host: options.rootHost }),
    isContentEditable: options.isContentEditable ?? false,
    localName,
    parentElement: options.parentElement,
    shadowRoot: options.shadowActiveElement ? { activeElement: options.shadowActiveElement } : undefined
  };
}

type KeyboardEventStub = Parameters<typeof shouldIgnoreMacroShortcutEvent>[0];

function createKeyboardEventStub(overrides: Partial<KeyboardEventStub> = {}): KeyboardEventStub {
  return {
    composedPath: () => [],
    defaultPrevented: false,
    isComposing: false,
    key: "a",
    keyCode: 65,
    target: null,
    ...overrides
  };
}
