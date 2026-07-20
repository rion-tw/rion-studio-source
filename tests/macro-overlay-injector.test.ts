import { runInNewContext } from "node:vm";

import { describe, expect, it, vi, type Mock } from "vitest";

import {
  MACRO_SHORTCUT_GUARD_SOURCE,
  MACRO_OVERLAY_SCRIPT,
  MacroOverlayInjector,
  isMacroOverlayRequest,
  shouldIgnoreMacroShortcutEvent,
  type MacroOverlayRequest
} from "../src/main/macros/MacroOverlayInjector";
import { formatMacroCoordinateClipboard } from "../src/shared/macroCoordinates";
import type {
  Macro,
  MacroBadgePositionSettings,
  MacroRunStatus,
  Role,
  RoleStatus
} from "../src/shared/types";

type AnyMock = Mock;

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Main",
  launchUrl: "https://example.com/play",
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
    const copyCoordinateToClipboard = vi.fn();
    const injector = createInjector({ macroManager, onMacroPageRequested, copyCoordinateToClipboard });

    await injector.installExternal(role, host as never);
    expect(host.installMacroOverlay).toHaveBeenCalledWith(MACRO_OVERLAY_SCRIPT, expect.any(Function));
    await expect(requestHandler?.({ type: "start", macroId: assignedMacro.id })).resolves.toMatchObject({
      macros: [{ id: assignedMacro.id }]
    });
    await expect(requestHandler?.({ type: "game-input-context", active: true })).resolves.toEqual({
      macros: [],
      statuses: []
    });
    const coordinate = {
      type: "copy-coordinate",
      viewportHeightPx: 800,
      viewportWidthPx: 1000,
      xPercent: 12.34,
      xPx: 123,
      yPercent: 56.78,
      yPx: 456
    };
    await expect(requestHandler?.(coordinate)).resolves.toMatchObject({
      macros: [{ id: assignedMacro.id }]
    });
    expect(copyCoordinateToClipboard).toHaveBeenCalledWith({
      xPercent: coordinate.xPercent,
      xPx: coordinate.xPx,
      viewportHeightPx: coordinate.viewportHeightPx,
      viewportWidthPx: coordinate.viewportWidthPx,
      yPercent: coordinate.yPercent,
      yPx: coordinate.yPx
    });
    await requestHandler?.({ type: "open" });
    await expect(requestHandler?.({ type: "unknown" })).rejects.toThrow("Invalid macro overlay request");
    await expect(requestHandler?.({ type: "game-input-context", active: "yes" }))
      .rejects.toThrow("Invalid macro overlay request");
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
      expect(host.evaluate).toHaveBeenCalledWith("void window.__rionStudioMacroOverlay?.refresh?.()")
    );
  });

  it("includes the current macro badge position in overlay state", async () => {
    const macroBadgePosition: MacroBadgePositionSettings = {
      horizontalAlign: "right",
      horizontalMarginPx: 80,
      topPx: 280
    };
    const injector = createInjector({
      getMacroBadgePosition: vi.fn().mockResolvedValue(macroBadgePosition)
    });

    await expect(injector.handleRequest(role.id, { type: "list" })).resolves.toMatchObject({
      macroBadgePosition
    });
  });

  it("coalesces a dense external refresh burst to one in-flight and one trailing request", async () => {
    const firstRefresh = createDeferred<void>();
    const host = {
      evaluate: vi.fn()
        .mockImplementationOnce(() => firstRefresh.promise)
        .mockResolvedValue(undefined),
      installMacroOverlay: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(() => () => undefined)
    };
    const injector = createInjector();
    await injector.installExternal(role, host);

    for (let index = 0; index < 50; index += 1) {
      injector.refreshInstalledOverlays(role.id, "burst_test");
    }
    expect(host.evaluate).toHaveBeenCalledTimes(1);

    firstRefresh.resolve();
    await vi.waitFor(() => expect(host.evaluate).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(host.evaluate).toHaveBeenCalledTimes(2);
  });

  it("drops a queued external refresh when the host disconnects", async () => {
    const firstRefresh = createDeferred<void>();
    let disconnect: (() => void) | undefined;
    const host = {
      evaluate: vi.fn(() => firstRefresh.promise),
      installMacroOverlay: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn((listener: () => void) => {
        disconnect = listener;
        return () => undefined;
      })
    };
    const injector = createInjector();
    await injector.installExternal(role, host as never);

    injector.refreshInstalledOverlays(role.id, "first");
    injector.refreshInstalledOverlays(role.id, "trailing");
    disconnect?.();
    firstRefresh.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.evaluate).toHaveBeenCalledTimes(1);
  });

  it("refreshes only roles whose macro presentation changed", async () => {
    const secondRole = { ...role, id: "role-2", name: "Second" };
    const firstHost = createExternalHost();
    const secondHost = createExternalHost();
    const injector = createInjector();
    await injector.installExternal(role, firstHost.host);
    await injector.installExternal(secondRole, secondHost.host);

    const firstStatus = runStatus(role.id, assignedMacro.id);
    const secondStatus = runStatus(secondRole.id, assignedMacro.id);
    injector.refreshChangedMacroStatuses([firstStatus, secondStatus]);
    await vi.waitFor(() => {
      expect(firstHost.host.evaluate).toHaveBeenCalledTimes(1);
      expect(secondHost.host.evaluate).toHaveBeenCalledTimes(1);
    });
    firstHost.host.evaluate.mockClear();
    secondHost.host.evaluate.mockClear();

    injector.refreshChangedMacroStatuses([
      { ...firstStatus, state: "stopping" },
      secondStatus
    ]);
    await vi.waitFor(() => expect(firstHost.host.evaluate).toHaveBeenCalledTimes(1));
    expect(secondHost.host.evaluate).not.toHaveBeenCalled();
  });

  it("refreshes the matching role when a click sequence advances", async () => {
    const host = createExternalHost();
    const injector = createInjector();
    await injector.installExternal(role, host.host);

    const initial = runStatus(role.id, assignedMacro.id);
    injector.refreshChangedMacroStatuses([initial]);
    await vi.waitFor(() => expect(host.host.evaluate).toHaveBeenCalledTimes(1));
    host.host.evaluate.mockClear();

    injector.refreshChangedMacroStatuses([{
      ...initial,
      lastClick: { sequence: 1, stepId: "click-step" },
      updatedAt: "2026-07-20T00:00:01.000Z"
    }]);
    await vi.waitFor(() => expect(host.host.evaluate).toHaveBeenCalledTimes(1));
  });

  it("reinstalls after navigation and keeps event setup idempotent", async () => {
    const page = createPage();
    const injector = createInjector();

    await injector.install(role, page.page as never);
    await injector.install(role, page.page as never);
    page.handlers.didFinishLoad?.();

    await vi.waitFor(() => expect(page.page.executeJavaScript).toHaveBeenCalledTimes(3));
    expect(page.page.on).toHaveBeenCalledTimes(3);
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

  it("hides assigned macros whose workflow contains an unassigned macro", async () => {
    const unassignedChild: Macro = {
      ...assignedMacro,
      id: "unassigned-child",
      roleIds: [],
      trigger: undefined
    };
    const blockedParent: Macro = {
      ...assignedMacro,
      id: "blocked-parent",
      roleIds: [role.id],
      steps: [{ id: "call-child", type: "macro", macroId: unassignedChild.id }]
    };
    const injector = new MacroOverlayInjector(
      { listMacros: vi.fn().mockResolvedValue([assignedMacro, blockedParent, unassignedChild]) },
      {
        listStatuses: vi.fn(() => []),
        startForRole: vi.fn(),
        stopForRole: vi.fn()
      }
    );

    await expect(injector.handleRequest(role.id, { type: "list" })).resolves.toMatchObject({
      macros: [{ id: assignedMacro.id }]
    });
  });

  it("can proactively refresh installed overlay pages", async () => {
    const page = createPage();
    const injector = createInjector();

    await injector.install(role, page.page as never);
    injector.refreshInstalledOverlays(role.id);

    await vi.waitFor(() =>
      expect(page.page.executeJavaScript).toHaveBeenCalledWith(
        "void window.__rionStudioMacroOverlay?.refresh?.()"
      )
    );
  });

  it("coalesces a dense embedded refresh burst to one in-flight and one trailing request", async () => {
    const firstRefresh = createDeferred<void>();
    const page = createPage();
    const onEmbeddedRefresh = vi.fn();
    const injector = createInjector({ onEmbeddedRefresh });
    await injector.install(role, page.page as never);
    page.page.executeJavaScript.mockReset()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValue(undefined);

    for (let index = 0; index < 50; index += 1) {
      injector.refreshInstalledOverlays(role.id, "burst_test");
    }
    expect(page.page.executeJavaScript).toHaveBeenCalledTimes(1);

    firstRefresh.resolve();
    await vi.waitFor(() => expect(page.page.executeJavaScript).toHaveBeenCalledTimes(2));
    expect(onEmbeddedRefresh).toHaveBeenNthCalledWith(1, {
      roleId: role.id,
      source: "burst_test",
      trailing: false
    });
    expect(onEmbeddedRefresh).toHaveBeenNthCalledWith(2, {
      roleId: role.id,
      source: "burst_test",
      trailing: true
    });
  });

  it("drops a queued embedded refresh when the web contents is destroyed", async () => {
    const firstRefresh = createDeferred<void>();
    const page = createPage();
    const injector = createInjector();
    await injector.install(role, page.page as never);
    page.page.executeJavaScript.mockReset().mockImplementation(() => firstRefresh.promise);

    injector.refreshInstalledOverlays(role.id, "first");
    injector.refreshInstalledOverlays(role.id, "trailing");
    page.destroy();
    firstRefresh.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(page.page.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it("drops a queued embedded refresh after a main-frame navigation failure", async () => {
    const firstRefresh = createDeferred<void>();
    const page = createPage();
    const injector = createInjector();
    await injector.install(role, page.page as never);
    page.page.executeJavaScript.mockReset().mockImplementation(() => firstRefresh.promise);

    injector.refreshInstalledOverlays(role.id, "first");
    injector.refreshInstalledOverlays(role.id, "trailing");
    page.handlers.didFailLoad?.({}, -2, "failed", "https://example.com/play", true);
    firstRefresh.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(page.page.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it("keeps a stable trigger while exposing the coordinate action menu", () => {
    expect(MACRO_OVERLAY_SCRIPT).toContain('const hostId = "rion-studio-macro-overlay-v52"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('const scriptVersion = "2026-07-20.10"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("let refreshInFlight = null");
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
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="click-marker-layer" hidden aria-hidden="true"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="click-marker-icon"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("stroke-width:1;width:100%");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".click-marker-ring{fill:none;}");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".click-marker-dot{fill:currentColor;stroke:none;");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".click-marker.is-click-flash");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".click-marker-layer{inset:0;pointer-events:none");
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="action-menu" hidden role="menu"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="coordinate-anchor-layer" hidden aria-hidden="true"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="coordinate-anchor-marker" data-anchor="');
    expect(MACRO_OVERLAY_SCRIPT).toContain(".coordinate-anchor-marker::before");
    expect(MACRO_OVERLAY_SCRIPT).toContain("border-top:1px dashed rgba(236,72,153,.78)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("border-left:1px dashed rgba(236,72,153,.78)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("pointer-events:none;position:absolute");
    expect(MACRO_OVERLAY_SCRIPT).toContain('type: "copy-coordinate"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("coordinateMeasureActive");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("focusAutomationTarget");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("document.activeElement === element");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('querySelectorAll("canvas");');
  });

  it("routes coordinate copies to the injected clipboard writer", async () => {
    const copyCoordinateToClipboard = vi.fn();
    const injector = createInjector({ copyCoordinateToClipboard });
    const coordinate = {
      viewportHeightPx: 800,
      viewportWidthPx: 1000,
      xPercent: 12.34,
      xPx: 123,
      yPercent: 56.78,
      yPx: 456
    };

    await expect(injector.handleRequest(role.id, { type: "copy-coordinate", ...coordinate }))
      .resolves.toMatchObject({ macros: [{ id: assignedMacro.id }] });

    expect(copyCoordinateToClipboard).toHaveBeenCalledWith(coordinate);
  });

  it.each([
    { type: "copy-coordinate", xPercent: 12, xPx: 123, yPercent: 45, yPx: -1 },
    { type: "copy-coordinate", xPercent: 101, xPx: 123, yPercent: 45, yPx: 456 },
    { type: "copy-coordinate", xPercent: 12, xPx: 123.5, yPercent: 45, yPx: 456 },
    { type: "copy-coordinate", viewportWidthPx: 100, viewportHeightPx: 100, xPercent: 12, xPx: 100, yPercent: 45, yPx: 45 },
    { type: "copy-coordinate", viewportWidthPx: 0, viewportHeightPx: 100, xPercent: 12, xPx: 0, yPercent: 45, yPx: 45 }
  ])("rejects invalid coordinate request %j", (request) => {
    expect(isMacroOverlayRequest(request)).toBe(false);
  });

  it("uses the shared coordinate clipboard format", () => {
    expect(formatMacroCoordinateClipboard({ xPercent: 12.345, xPx: 123, yPercent: 56.789, yPx: 456 }))
      .toBe("X: 123px (12.35%), Y: 456px (56.79%)");
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
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="active-badge-behavior"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('const iterationFlashClass = iteration > 0 ? " is-iteration-flash" : "";');
    expect(MACRO_OVERLAY_SCRIPT).toContain("getMacroIteration(macro.id)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("--active-badge-flash-duration:");
    expect(MACRO_OVERLAY_SCRIPT).toContain("--active-badge-flash-delay:");
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      "animation:active-badge-border-flash var(--active-badge-flash-duration,120ms) ease-out var(--active-badge-flash-delay,0ms) 1 both"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain('background:rgba(0,0,0,.22)');
    expect(MACRO_OVERLAY_SCRIPT).toContain('font-size:10px');
    expect(MACRO_OVERLAY_SCRIPT).toContain('font-size:8px');
    expect(MACRO_OVERLAY_SCRIPT).toContain('height:16px');
    expect(MACRO_OVERLAY_SCRIPT).toContain('padding:4px 8px 4px 4px');
    expect(MACRO_OVERLAY_SCRIPT).toContain("left:0");
    expect(MACRO_OVERLAY_SCRIPT).toContain("top:128px");
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
    const contextIndex = handler.indexOf(
      "const activeElement = gameInputContextActive ? undefined : document.activeElement"
    );
    const guardIndex = handler.indexOf(
      "shouldIgnoreShortcutEvent(event, activeElement, document.designMode)"
    );

    expect(contextIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(contextIndex).toBeLessThan(guardIndex);
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
  onMacroPageRequested,
  onEmbeddedRefresh,
  getMacroBadgePosition,
  copyCoordinateToClipboard
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
  onEmbeddedRefresh?: AnyMock;
  getMacroBadgePosition?: () => Promise<MacroBadgePositionSettings>;
  copyCoordinateToClipboard?: AnyMock;
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
    getRoleStatus,
    undefined,
    onEmbeddedRefresh,
    getMacroBadgePosition,
    copyCoordinateToClipboard
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
    didFailLoad?: (
      event: unknown,
      code: number,
      description: string,
      url: string,
      isMainFrame: boolean
    ) => void;
    didStartNavigation?: (
      event: unknown,
      url: string,
      isInPlace: boolean,
      isMainFrame: boolean
    ) => void;
    destroyed?: () => void;
  } = {};
  let destroyed = false;
  const page = {
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn(() => destroyed),
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      if (event === "did-finish-load") handlers.didFinishLoad = handler;
      if (event === "did-fail-load") {
        handlers.didFailLoad = handler as typeof handlers.didFailLoad;
      }
      if (event === "did-start-navigation") {
        handlers.didStartNavigation = handler as typeof handlers.didStartNavigation;
      }
    }),
    once: vi.fn((event: string, handler: () => void) => {
      if (event === "destroyed") handlers.destroyed = handler;
    })
  };
  return {
    destroy: () => {
      destroyed = true;
      handlers.destroyed?.();
    },
    handlers,
    page
  };
}

function createExternalHost() {
  const host = {
    evaluate: vi.fn().mockResolvedValue(undefined),
    installMacroOverlay: vi.fn().mockResolvedValue(undefined),
    onDisconnect: vi.fn(() => () => undefined)
  };
  return { host };
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
