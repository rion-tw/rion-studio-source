import { runInNewContext } from "node:vm";

import { describe, expect, it, vi, type Mock } from "vitest";

import {
  MACRO_SHORTCUT_GUARD_SOURCE,
  MACRO_OVERLAY_SCRIPT,
  MacroOverlayInjector,
  shouldIgnoreMacroShortcutEvent
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
  launchPreset: "performance",
  authState: "authenticated",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const assignedMacro: Macro = {
  id: "macro-1",
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
    const injector = createInjector({ macroManager });

    await injector.installExternal(role, host);
    expect(host.installMacroOverlay).toHaveBeenCalledWith(MACRO_OVERLAY_SCRIPT, expect.any(Function));
    await expect(requestHandler?.({ type: "start", macroId: "macro-1" })).resolves.toMatchObject({
      macros: [{ id: "macro-1" }]
    });
    await expect(requestHandler?.({ type: "unknown" })).rejects.toThrow("Invalid macro overlay request");
    expect(macroManager.start).toHaveBeenCalledWith("macro-1");

    injector.refreshInstalledOverlays(role.id);
    await vi.waitFor(() =>
      expect(host.evaluate).toHaveBeenCalledWith(
        "window.__rionStudioMacroOverlay?.refresh?.({ renderAfter: true })"
      )
    );
  });

  it("reinstalls after navigation and keeps event setup idempotent", async () => {
    const page = createPage();
    const injector = createInjector();

    await injector.install(role, page.page as never);
    await injector.install(role, page.page as never);
    page.handlers.didFinishLoad?.();

    await vi.waitFor(() => expect(page.page.executeJavaScript).toHaveBeenCalledTimes(3));
    expect(page.page.on).toHaveBeenCalledTimes(1);
  });

  it("filters overlay state and routes start and stop requests", async () => {
    const page = createPage();
    const statuses: MacroRunStatus[] = [
      {
        roleId: "role-1",
        macroId: "macro-1",
        state: "running",
        startedAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z"
      },
      {
        roleId: "role-2",
        macroId: "macro-1",
        state: "running",
        startedAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z"
      },
      {
        roleId: "role-2",
        macroId: "macro-2",
        state: "running",
        startedAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z"
      }
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

    const listState = await injector.handleRequest(role.id, { type: "list" });
    const startState = await injector.handleRequest(role.id, { type: "start", macroId: "macro-1" });
    await injector.handleRequest(role.id, { type: "stop", macroId: "macro-1" });

    expect(listState).toMatchObject({
      language: "zh-TW",
      resourceState: "throttled",
      cpuThrottleRate: 2,
      macros: [{ id: "macro-1" }],
      statuses: [
        { roleId: "role-1", macroId: "macro-1" },
        { roleId: "role-2", macroId: "macro-1" }
      ]
    });
    expect(startState).toMatchObject({
      macros: [{ id: "macro-1" }],
      startSummary: { skippedCount: 1, startedCount: 1 }
    });
    macroManager.start.mockResolvedValueOnce([statuses[0], statuses[1]]);
    await expect(
      injector.handleRequest(role.id, { type: "start", macroId: "macro-1" })
    ).resolves.toMatchObject({ startSummary: { skippedCount: 0, startedCount: 2 } });
    expect(macroManager.start).toHaveBeenCalledWith("macro-1");
    expect(macroManager.stop).toHaveBeenCalledWith("macro-1");
  });

  it("rejects edit, start, and stop requests for macros not assigned to the overlay role", async () => {
    const onMacroEditorRequested = vi.fn();
    const macroManager = {
      listStatuses: vi.fn(() => []),
      start: vi.fn().mockResolvedValue([]),
      stop: vi.fn().mockResolvedValue(undefined)
    };
    const injector = createInjector({ macroManager, onMacroEditorRequested });

    for (const type of ["edit", "start", "stop"] as const) {
      await expect(injector.handleRequest(role.id, { type, macroId: "macro-2" })).rejects.toThrow(
        "This macro is not assigned to the current role."
      );
    }

    expect(onMacroEditorRequested).not.toHaveBeenCalled();
    expect(macroManager.start).not.toHaveBeenCalled();
    expect(macroManager.stop).not.toHaveBeenCalled();
  });

  it("routes create and edit requests with the installed role id", async () => {
    const page = createPage();
    const onMacroEditorRequested = vi.fn();
    const injector = createInjector({ onMacroEditorRequested });

    await injector.install(role, page.page as never);

    await injector.handleRequest(role.id, { type: "create" });
    await injector.handleRequest(role.id, { type: "edit", macroId: "macro-1" });

    expect(onMacroEditorRequested).toHaveBeenNthCalledWith(1, { roleId: "role-1" });
    expect(onMacroEditorRequested).toHaveBeenNthCalledWith(2, {
      macroId: "macro-1",
      roleId: "role-1"
    });
  });

  it("rejects overlay edits while any assigned role is active", async () => {
    const onMacroEditorRequested = vi.fn();
    const macroManager = {
      listStatuses: vi.fn(() => [{
        roleId: "role-2",
        macroId: "macro-1",
        state: "running",
        startedAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z"
      }] satisfies MacroRunStatus[]),
      start: vi.fn().mockResolvedValue([]),
      stop: vi.fn().mockResolvedValue(undefined)
    };
    const injector = createInjector({ macroManager, onMacroEditorRequested });

    await expect(injector.handleRequest(role.id, { type: "edit", macroId: "macro-1" })).rejects.toThrow(
      "Stop the macro before editing it."
    );
    expect(onMacroEditorRequested).not.toHaveBeenCalled();
  });

  it("captures statuses after an asynchronous macro list finishes", async () => {
    const macros = createDeferred<Macro[]>();
    let statuses: MacroRunStatus[] = [];
    const injector = new MacroOverlayInjector(
      { listMacros: vi.fn(() => macros.promise) } as never,
      {
        listStatuses: vi.fn(() => statuses),
        startForRole: vi.fn(),
        stopForRole: vi.fn()
      } as never
    );

    const state = injector.handleRequest(role.id, { type: "list" });
    statuses = [{
      roleId: role.id,
      macroId: assignedMacro.id,
      state: "running",
      startedAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }];
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
        "window.__rionStudioMacroOverlay?.refresh?.({ renderAfter: true })"
      )
    );
  });

  it("keeps the overlay script wired for physical-code shortcuts and menu toggle", () => {
    expect(MACRO_OVERLAY_SCRIPT).toContain('event.code === "KeyM"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("event.code === trigger.code");
    expect(MACRO_OVERLAY_SCRIPT).toContain("stopImmediatePropagation");
    expect(MACRO_OVERLAY_SCRIPT).toContain("setInterval");
    expect(MACRO_OVERLAY_SCRIPT).toContain("[\"pointer-events\", \"none\"]");
    expect(MACRO_OVERLAY_SCRIPT).toContain("[\"max-width\", \"320px\"]");
    expect(MACRO_OVERLAY_SCRIPT).toContain('const hostId = "rion-studio-macro-overlay-v26"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("rion-studio-macro-overlay-v25");
    expect(MACRO_OVERLAY_SCRIPT).toContain('const scriptVersion = "2026-07-15.2"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("if (event.repeat)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("const pendingMacroActions = new Set()");
    expect(MACRO_OVERLAY_SCRIPT).toContain("requestVersion: 0");
    expect(MACRO_OVERLAY_SCRIPT).toContain("dispose");
    expect(MACRO_OVERLAY_SCRIPT).toContain("host.style.setProperty(property, value, \"important\")");
    expect(MACRO_OVERLAY_SCRIPT).toContain("[\"right\", \"8px\"]");
    expect(MACRO_OVERLAY_SCRIPT).toContain("[\"top\", \"8px\"]");
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      "[\"font-family\", \"system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif\"]"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain("[\"-webkit-font-smoothing\", \"antialiased\"]");
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      "*{box-sizing:border-box;font-family:inherit;-webkit-font-smoothing:antialiased;}"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain("document.body.appendChild(host)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("return window.top === window;");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("Boolean(document.fullscreenElement)");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('class="close"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('aria-label="Close"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('title="\' + escapeHtml(text.triggerTitle) + \'"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('aria-label="\' + escapeHtml(text.triggerAria) + \'"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('aria-label="Rion Studio Macros">M</button>');
    expect(MACRO_OVERLAY_SCRIPT).toContain('<svg class="trigger-icon" viewBox="0 0 24 24"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('aria-hidden="true" focusable="false"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('<rect width="20" height="16" x="2" y="4" rx="2"/>');
    expect(MACRO_OVERLAY_SCRIPT).toContain('<path d="M7 16h10"/>');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('fill="currentColor"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("height:32px;justify-content:center;");
    expect(MACRO_OVERLAY_SCRIPT).toContain("width:32px;}");
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      ".trigger-icon{display:block;fill:none;height:16px;width:16px;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.75;"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain("stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:2;");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("<span>Macros</span>");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('class="refresh"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("refreshFromMenu");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".status-dot.running");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".status-dot.idle");
  });

  it("renders macro menu rows with value badges and an edit action", () => {
    const macroContentIndex = MACRO_OVERLAY_SCRIPT.indexOf("state.macros.length > 0 ? macroRows :");
    const createRowIndex = MACRO_OVERLAY_SCRIPT.indexOf("'<button class=\"create-row\"");

    expect(MACRO_OVERLAY_SCRIPT).toContain("function formatRepeat(repeat)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function formatStep(step)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function formatSteps(steps)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("return text.noShortcut;");
    expect(MACRO_OVERLAY_SCRIPT).toContain('return text.everyMs.replace("{ms}", String(repeat.intervalMs));');
    expect(MACRO_OVERLAY_SCRIPT).toContain("return text.noSteps;");
    expect(MACRO_OVERLAY_SCRIPT).toContain('return text.keyStep + ":" + formatCode(step.code);');
    expect(MACRO_OVERLAY_SCRIPT).toContain('return text.clickStep + ":X " + step.xPercent + "%, Y " + step.yPercent + "%";');
    expect(MACRO_OVERLAY_SCRIPT).toContain('return text.delayStep + ":" + step.ms + "ms";');
    expect(MACRO_OVERLAY_SCRIPT).toContain('visibleSteps.push(text.stepsMore.replace("{count}", String(steps.length - visibleSteps.length)));');
    expect(MACRO_OVERLAY_SCRIPT).toContain("const steps = formatSteps(macro.steps);");
    expect(MACRO_OVERLAY_SCRIPT).toContain("const poll = formatRepeat(macro.repeat);");
    expect(MACRO_OVERLAY_SCRIPT).toContain('<div class="macro-row" role="menuitem"><span class="macro-title"><span class="status-dot ');
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="create-row"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('data-action="create"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('await binding({ type: "create" });');
    expect(MACRO_OVERLAY_SCRIPT).toContain('</strong></span><span class="macro-details"><span class="macro-detail-steps"><b>');
    expect(MACRO_OVERLAY_SCRIPT).toContain('<span class="macro-detail-shortcut"><b>');
    expect(MACRO_OVERLAY_SCRIPT).toContain('<span class="macro-detail-poll"><b>');
    expect(MACRO_OVERLAY_SCRIPT).toContain('<button class="macro-edit" type="button"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('disabled aria-disabled="true"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("if (button.disabled)");
    expect(MACRO_OVERLAY_SCRIPT).toContain('<svg class="create-icon" viewBox="0 0 24 24"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('<path d="M12 5v14"/>');
    expect(MACRO_OVERLAY_SCRIPT).toContain('<path d="M5 12h14"/>');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('<span class="create-icon" aria-hidden="true">+</span>');
    expect(MACRO_OVERLAY_SCRIPT).toContain('<svg class="edit-icon" viewBox="0 0 24 24"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('await binding({ type: "edit", macroId });');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("escapeHtml(text.stepsLabel)");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("escapeHtml(text.shortcutLabel)");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("escapeHtml(text.pollLabel)");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('class="macro-action-pill');
    expect(MACRO_OVERLAY_SCRIPT).toContain(".create-row{");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".create-icon{");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain(".macro-list{");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('class="macro-list"');
    expect(macroContentIndex).toBeGreaterThan(-1);
    expect(createRowIndex).toBeGreaterThan(-1);
    expect(macroContentIndex).toBeLessThan(createRowIndex);
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-row{");
    expect(MACRO_OVERLAY_SCRIPT).toContain("grid-template-areas:'title shortcut poll edit' 'steps steps steps steps'");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain(".macro-header{");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-title{");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-details{display:contents;}");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-detail-shortcut{grid-area:shortcut;}");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-detail-poll{grid-area:poll;}");
    expect(MACRO_OVERLAY_SCRIPT).toContain("grid-area:steps");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-edit{");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".edit-icon{");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".panel{display:");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".trigger{");
    expect(MACRO_OVERLAY_SCRIPT).toContain("pointer-events:auto");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".status-dot{");
  });

  it("localizes overlay menu text for English and Traditional Chinese", () => {
    expect(MACRO_OVERLAY_SCRIPT).toContain("const overlayTexts = {");
    expect(MACRO_OVERLAY_SCRIPT).toContain('addMacro: "Add macro"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('addMacro: "新增巨集"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('createError: "無法開啟 Rion Studio。"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('edit: "Edit"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('edit: "編輯"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('editError: "無法在 Rion Studio 開啟此巨集。"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('stepsLabel: "Steps"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('shortcutLabel: "快捷鍵"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('pollLabel: "輪詢"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('keyStep: "按鍵"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('everyMs: "每 {ms} ms"');
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      'partialStartNotice: "已在 {started} 個角色啟動，略過 {skipped} 個未啟動或無法控制的角色。"'
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain("language: detectOverlayLanguage()");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function getText()");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function normalizeOverlayLanguage(language)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("state.language = normalizeOverlayLanguage(nextState?.language) ?? state.language;");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function detectOverlayLanguage()");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function isTraditionalChineseLocale(locale)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function isSimplifiedChineseLocale(locale)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function isJapaneseLocale(locale)");
    expect(MACRO_OVERLAY_SCRIPT).toContain('return "zh-CN";');
    expect(MACRO_OVERLAY_SCRIPT).toContain('return "ja";');
  });

  it("renders a transient partial-start notice outside the menu panel", () => {
    expect(MACRO_OVERLAY_SCRIPT).toContain("function showStartNotice(summary)");
    expect(MACRO_OVERLAY_SCRIPT).toContain('if (action === "start")');
    expect(MACRO_OVERLAY_SCRIPT).toContain("showStartNotice(nextState?.startSummary)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("}, 4000);");
    expect(MACRO_OVERLAY_SCRIPT).toContain('state.notice ? \'<div class="notice" role="status">\'');
    expect(MACRO_OVERLAY_SCRIPT).toContain(".notice{");
  });

  it("renders passive running macro badges at the top-center of the browser view", () => {
    const runningBadgeFunction = MACRO_OVERLAY_SCRIPT.slice(
      MACRO_OVERLAY_SCRIPT.indexOf("function getRunningBadgeMacros()"),
      MACRO_OVERLAY_SCRIPT.indexOf("function getRunningBadgeSignature()")
    );
    const activeBadgeStyles = MACRO_OVERLAY_SCRIPT.slice(
      MACRO_OVERLAY_SCRIPT.indexOf(".active-badge{"),
      MACRO_OVERLAY_SCRIPT.indexOf(".active-badge-name{")
    );

    expect(MACRO_OVERLAY_SCRIPT).toContain("function getRunningBadgeMacros()");
    expect(MACRO_OVERLAY_SCRIPT).toContain("return state.macros.filter((macro) => isRunning(macro.id));");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function getRunningBadgeSignature()");
    expect(MACRO_OVERLAY_SCRIPT).toContain("[macro.id, macro.name, formatShortcut(macro.trigger)]");
    expect(MACRO_OVERLAY_SCRIPT).toContain("const shortcut = formatShortcut(macro.trigger);");
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="active-badge" aria-hidden="true"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="active-badge-name"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="active-badge-shortcut"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="active-badges" aria-hidden="true"');
    expect(MACRO_OVERLAY_SCRIPT).toContain(".active-badges{align-items:center;display:flex;flex-wrap:nowrap;gap:");
    expect(MACRO_OVERLAY_SCRIPT).toContain("left:50%");
    expect(MACRO_OVERLAY_SCRIPT).toContain("top:20%");
    expect(MACRO_OVERLAY_SCRIPT).toContain("transform:translateX(-50%)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("pointer-events:none;position:fixed");
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      ".active-badge{-webkit-backdrop-filter:blur(30px) saturate(140%);-webkit-font-smoothing:antialiased;align-items:center;"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain("font-size:10px");
    expect(MACRO_OVERLAY_SCRIPT).toContain("min-height:20px");
    expect(MACRO_OVERLAY_SCRIPT).toContain("padding:4px 8px");
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      "backdrop-filter:blur(30px) saturate(140%);background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,0) 46%),rgba(20,23,31,.5);border:1px solid rgba(255,255,255,.14);"
    );
    expect(activeBadgeStyles).toContain("box-shadow:0 8px 24px rgba(0,0,0,.2);");
    expect(activeBadgeStyles).toContain("font-size:10px;gap:5px;");
    expect(activeBadgeStyles).not.toContain("text-shadow");
    expect(activeBadgeStyles).not.toContain("inset");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".active-badge-name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".active-badge-shortcut{color:#fff;display:block;flex:0 0 auto;font-size:9.5px;font-weight:600;");
    expect(MACRO_OVERLAY_SCRIPT).toContain("previousRunningBadgeSignature !== getRunningBadgeSignature()");
    expect(runningBadgeFunction).not.toContain("isStopping");
  });

  it("isolates overlay controls without redirecting outside pointer events", () => {
    expect(MACRO_OVERLAY_SCRIPT).toContain('tabindex="-1"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('addEventListener("pointerdown"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("event.preventDefault()");
    expect(MACRO_OVERLAY_SCRIPT).toContain("focusAutomationTarget");
    expect(MACRO_OVERLAY_SCRIPT).toContain("closePanel({ focus: true })");
    expect(MACRO_OVERLAY_SCRIPT).toContain("closePanel({ focus: false })");
    expect(MACRO_OVERLAY_SCRIPT).toContain("postTopMessage(\"closePanel\")");

    const pointerHandler = MACRO_OVERLAY_SCRIPT.slice(
      MACRO_OVERLAY_SCRIPT.indexOf("function handleDocumentPointerDown(event)"),
      MACRO_OVERLAY_SCRIPT.indexOf("function handleMessage(event)")
    );

    expect(pointerHandler).not.toContain("focusAutomationTarget");
    expect(pointerHandler).not.toContain("preventDefault");
    expect(pointerHandler).not.toContain("stopPropagation");
  });

  it("initializes overlay host state before cleaning stale injected hosts", () => {
    expect(MACRO_OVERLAY_SCRIPT.indexOf("let host = null")).toBeGreaterThan(-1);
    expect(MACRO_OVERLAY_SCRIPT.indexOf("removeLegacyHosts();")).toBeGreaterThan(-1);
    expect(MACRO_OVERLAY_SCRIPT.indexOf("let host = null")).toBeLessThan(
      MACRO_OVERLAY_SCRIPT.indexOf("removeLegacyHosts();")
    );
  });
});

describe("macro shortcut editable guard", () => {
  it("ignores page-handled events, IME composition, and editable documents", () => {
    const body = createElementStub("body");

    expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ defaultPrevented: true }), body)).toBe(true);
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

    for (const role of ["searchbox", "combobox", "spinbutton"]) {
      const element = createElementStub("div", { attributes: { role } });
      expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ target: element }))).toBe(true);
    }
  });

  it("uses active element and open shadow-root focus as fallbacks", () => {
    const input = createElementStub("input");
    const shadowHost = createElementStub("game-chat", { shadowActiveElement: input });
    const canvas = createElementStub("canvas");

    expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ target: canvas }), input)).toBe(true);
    expect(shouldIgnoreMacroShortcutEvent(createKeyboardEventStub({ target: canvas }), shadowHost)).toBe(true);
    expect(
      shouldIgnoreMacroShortcutEvent(
        createKeyboardEventStub({ composedPath: () => [input, shadowHost], target: shadowHost }),
        shadowHost
      )
    ).toBe(true);
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

  it("runs the editable guard before refresh, menu, and macro matching", () => {
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      `const shouldIgnoreShortcutEvent = ${MACRO_SHORTCUT_GUARD_SOURCE};`
    );

    const handler = MACRO_OVERLAY_SCRIPT.slice(
      MACRO_OVERLAY_SCRIPT.indexOf("function handleKeyDown(event)"),
      MACRO_OVERLAY_SCRIPT.indexOf("function handleEscapeKeyDown(event)")
    );
    const guardIndex = handler.indexOf("shouldIgnoreShortcutEvent(event, document.activeElement, document.designMode)");

    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(handler.indexOf("refreshIfStale()"));
    expect(guardIndex).toBeLessThan(handler.indexOf("matchesMenuToggle(event)"));
    expect(guardIndex).toBeLessThan(handler.indexOf("matchesShortcut(event, item.trigger)"));
    expect(guardIndex).toBeLessThan(handler.indexOf("consumeShortcutEvent(event)"));
  });
});

function createInjector({
  getRoleStatus,
  macroManager = {
    listStatuses: vi.fn(() => []),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined)
  },
  onMacroEditorRequested
}: {
  macroManager?: {
    listStatuses: AnyMock;
    start: AnyMock;
    stop: AnyMock;
  };
  getRoleStatus?: (roleId: string) => RoleStatus | undefined;
  onMacroEditorRequested?: AnyMock;
} = {}): MacroOverlayInjector {
  const roleAwareMacroManager = {
    listStatuses: macroManager.listStatuses,
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
    {
      listMacros: vi.fn().mockResolvedValue([assignedMacro, otherMacro])
    } as never,
    roleAwareMacroManager as never,
    onMacroEditorRequested,
    getRoleStatus
  );
}

function createPage() {
  const handlers: { didFinishLoad?: () => void } = {};
  const page = {
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "did-finish-load") {
        handlers.didFinishLoad = handler;
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
