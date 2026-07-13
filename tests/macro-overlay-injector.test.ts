import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  MACRO_SHORTCUT_GUARD_SOURCE,
  MACRO_OVERLAY_SCRIPT,
  MacroOverlayInjector,
  shouldIgnoreMacroShortcutEvent
} from "../src/main/macros/MacroOverlayInjector";
import type { Macro, MacroRunStatus, Role } from "../src/shared/types";

const role: Role = {
  id: "role-1",
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
    const injector = createInjector({ macroManager });

    await injector.install(role, page.page as never);
    injector.setLanguage("zh-TW");

    const listState = await injector.handleRequest(role.id, { type: "list" });
    const startState = await injector.handleRequest(role.id, { type: "start", macroId: "macro-1" });
    await injector.handleRequest(role.id, { type: "stop", macroId: "macro-1" });

    expect(listState).toMatchObject({
      language: "zh-TW",
      macros: [{ id: "macro-1" }],
      statuses: [{ roleId: "role-1", macroId: "macro-1" }]
    });
    expect(startState).toMatchObject({
      macros: [{ id: "macro-1" }]
    });
    expect(macroManager.start).toHaveBeenCalledWith("macro-1");
    expect(macroManager.stop).toHaveBeenCalledWith("macro-1");
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
    expect(MACRO_OVERLAY_SCRIPT).toContain("[\"max-width\", \"300px\"]");
    expect(MACRO_OVERLAY_SCRIPT).toContain('const hostId = "rion-studio-macro-overlay-v19"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("rion-studio-macro-overlay-v18");
    expect(MACRO_OVERLAY_SCRIPT).toContain('const scriptVersion = "2026-07-14.2"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("dispose");
    expect(MACRO_OVERLAY_SCRIPT).toContain("host.style.setProperty(property, value, \"important\")");
    expect(MACRO_OVERLAY_SCRIPT).toContain("[\"right\", \"6px\"]");
    expect(MACRO_OVERLAY_SCRIPT).toContain("[\"top\", \"6px\"]");
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
      ".trigger-icon{display:block;fill:none;height:18px;width:18px;"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain("stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:2;");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("<span>Macros</span>");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('class="refresh"');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("refreshFromMenu");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".status-dot.running");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".status-dot.idle");
  });

  it("renders compact macro menu rows with value badges and an edit action", () => {
    const macroContentIndex = MACRO_OVERLAY_SCRIPT.indexOf("state.macros.length > 0 ? macroRows :");
    const createRowIndex = MACRO_OVERLAY_SCRIPT.indexOf("'<button class=\"create-row\"");
    const menuStyles = MACRO_OVERLAY_SCRIPT.slice(
      MACRO_OVERLAY_SCRIPT.indexOf(".panel{display:"),
      MACRO_OVERLAY_SCRIPT.indexOf(".active-badges{")
    );

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
    expect(MACRO_OVERLAY_SCRIPT).toContain('<svg class="edit-icon" viewBox="0 0 24 24"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('await binding({ type: "edit", macroId });');
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("escapeHtml(text.stepsLabel)");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("escapeHtml(text.shortcutLabel)");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("escapeHtml(text.pollLabel)");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('class="macro-action-pill');
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      ".create-row{align-items:center;border-radius:9px;color:rgba(255,255,255,.96);cursor:pointer;display:flex;"
    );
    expect(MACRO_OVERLAY_SCRIPT).not.toContain(".macro-list{");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('class="macro-list"');
    expect(macroContentIndex).toBeGreaterThan(-1);
    expect(createRowIndex).toBeGreaterThan(-1);
    expect(macroContentIndex).toBeLessThan(createRowIndex);
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      ".macro-row{align-items:center;border-radius:9px;color:rgba(255,255,255,.96);display:grid;"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain("grid-template-areas:'title shortcut poll edit' 'steps steps steps steps'");
    expect(MACRO_OVERLAY_SCRIPT).toContain("grid-template-columns:minmax(52px,1fr) auto auto 24px;min-height:58px");
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      ".macro-row:hover{background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,0) 48%),rgba(30,33,43,.88);"
    );
    expect(MACRO_OVERLAY_SCRIPT).not.toContain(".macro-header{");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-title{align-items:center;display:flex;gap:8px;grid-area:title;min-width:0;}");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-details{display:contents;}");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-details b{font-weight:750;min-width:0;overflow:hidden;");
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      ".macro-detail-shortcut,.macro-detail-poll{align-items:center;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-detail-shortcut{grid-area:shortcut;}");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-detail-poll{grid-area:poll;}");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-detail-steps{display:block;grid-area:steps;padding:0 1px;}");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-edit{align-items:center;background:rgba(255,255,255,.1);");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".edit-icon{display:block;fill:none;height:12px;width:12px;");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".panel{display:");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain(".panel{-webkit-backdrop-filter");
    expect(menuStyles).toContain(
      ".macro-row,.create-row,.empty,.error{-webkit-backdrop-filter:blur(22px) saturate(120%);backdrop-filter:blur(22px) saturate(120%);"
    );
    expect(menuStyles).toContain(
      "background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,0) 48%),rgba(18,20,28,.78);"
    );
    expect(menuStyles).toContain(
      "border:1px solid rgba(255,255,255,.18);box-shadow:0 10px 28px rgba(0,0,0,.28)"
    );
    expect(menuStyles).not.toContain("linear-gradient(135deg,rgba(255,255,255,.28),rgba(255,255,255,.08))");
    expect(menuStyles).not.toContain("text-shadow:0");
    expect(menuStyles).toContain(
      ";gap:7px;margin-top:6px;max-width:300px;padding:0;pointer-events:auto;text-shadow:none;"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      ".trigger{-webkit-backdrop-filter:blur(18px) saturate(190%);align-items:center;"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      ".trigger:hover{background:linear-gradient(135deg,rgba(255,255,255,.34),rgba(255,255,255,.13));"
    );
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

  it("renders passive running macro badges at the top-center of the browser view", () => {
    const runningBadgeFunction = MACRO_OVERLAY_SCRIPT.slice(
      MACRO_OVERLAY_SCRIPT.indexOf("function getRunningBadgeMacros()"),
      MACRO_OVERLAY_SCRIPT.indexOf("function getRunningBadgeSignature()")
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
    expect(MACRO_OVERLAY_SCRIPT).toContain(".active-badge{-webkit-backdrop-filter:blur(18px) saturate(190%);align-items:center;");
    expect(MACRO_OVERLAY_SCRIPT).toContain("font-size:10.5px");
    expect(MACRO_OVERLAY_SCRIPT).toContain("min-height:20px");
    expect(MACRO_OVERLAY_SCRIPT).toContain("padding:4px 8px");
    expect(MACRO_OVERLAY_SCRIPT).toContain("pointer-events:none;text-shadow:");
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      ".active-badge{-webkit-backdrop-filter:blur(18px) saturate(190%);align-items:center;backdrop-filter:blur(18px) saturate(190%);background:linear-gradient(135deg,rgba(255,255,255,.25),rgba(255,255,255,.075));"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain(".active-badge-name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".active-badge-shortcut{color:rgba(255,255,255,.66);display:block;flex:0 0 auto;font-size:9.5px;");
    expect(MACRO_OVERLAY_SCRIPT).toContain("previousRunningBadgeSignature !== getRunningBadgeSignature()");
    expect(runningBadgeFunction).not.toContain("isStopping");
  });

  it("keeps overlay controls from stealing focus and restores automation target focus", () => {
    expect(MACRO_OVERLAY_SCRIPT).toContain('tabindex="-1"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('addEventListener("pointerdown"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("event.preventDefault()");
    expect(MACRO_OVERLAY_SCRIPT).toContain("focusAutomationTarget");
    expect(MACRO_OVERLAY_SCRIPT).toContain("closePanel({ focus: true })");
    expect(MACRO_OVERLAY_SCRIPT).toContain("postTopMessage(\"closePanel\")");
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
  macroManager = {
    listStatuses: vi.fn(() => []),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined)
  },
  onMacroEditorRequested
}: {
  macroManager?: {
    listStatuses: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  onMacroEditorRequested?: ReturnType<typeof vi.fn>;
} = {}): MacroOverlayInjector {
  return new MacroOverlayInjector(
    {
      listMacros: vi.fn().mockResolvedValue([assignedMacro, otherMacro])
    } as never,
    macroManager as never,
    onMacroEditorRequested
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
