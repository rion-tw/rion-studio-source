import { describe, expect, it, vi } from "vitest";

import {
  MACRO_OVERLAY_SCRIPT,
  MacroOverlayInjector
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
  roleId: "role-1",
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
  roleId: "role-2"
};

describe("MacroOverlayInjector", () => {
  it("exposes the overlay binding and installs the script into current frames", async () => {
    const mainFrame = createFrame();
    const childFrame = createFrame();
    const page = createPage([mainFrame, childFrame]);
    const injector = createInjector();

    await injector.install(role, page.page as never);

    expect(page.page.exposeBinding).toHaveBeenCalledWith("rionStudioMacroOverlay", expect.any(Function));
    expect(page.page.addInitScript).toHaveBeenCalledWith({ content: MACRO_OVERLAY_SCRIPT });
    expect(mainFrame.evaluate).toHaveBeenCalledWith(MACRO_OVERLAY_SCRIPT);
    expect(childFrame.evaluate).toHaveBeenCalledWith(MACRO_OVERLAY_SCRIPT);
  });

  it("installs into future frames and keeps page setup idempotent", async () => {
    const mainFrame = createFrame();
    const attachedFrame = createFrame();
    const navigatedFrame = createFrame();
    const page = createPage([mainFrame], { rejectDuplicateBinding: true });
    const injector = createInjector();

    await injector.install(role, page.page as never);
    await injector.install(role, page.page as never);

    page.handlers.frameattached?.(attachedFrame as never);
    page.handlers.framenavigated?.(navigatedFrame as never);

    await vi.waitFor(() => expect(attachedFrame.evaluate).toHaveBeenCalledWith(MACRO_OVERLAY_SCRIPT));
    await vi.waitFor(() => expect(navigatedFrame.evaluate).toHaveBeenCalledWith(MACRO_OVERLAY_SCRIPT));

    expect(page.page.addInitScript).toHaveBeenCalledTimes(1);
    expect(page.page.on).toHaveBeenCalledTimes(2);
    expect(page.page.exposeBinding).toHaveBeenCalledTimes(2);
  });

  it("filters overlay state and routes start and stop requests", async () => {
    const page = createPage([createFrame()]);
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
      start: vi.fn().mockResolvedValue(statuses[0]),
      stop: vi.fn().mockResolvedValue(undefined)
    };
    const injector = createInjector({ macroManager });

    await injector.install(role, page.page as never);
    injector.setLanguage("zh-TW");

    const listState = await page.binding?.({}, { type: "list" });
    const startState = await page.binding?.({}, { type: "start", macroId: "macro-1" });
    await page.binding?.({}, { type: "stop", macroId: "macro-1" });

    expect(listState).toMatchObject({
      language: "zh-TW",
      macros: [{ id: "macro-1" }],
      statuses: [{ roleId: "role-1", macroId: "macro-1" }]
    });
    expect(startState).toMatchObject({
      macros: [{ id: "macro-1" }]
    });
    expect(macroManager.start).toHaveBeenCalledWith("role-1", "macro-1");
    expect(macroManager.stop).toHaveBeenCalledWith("role-1", "macro-1");
  });

  it("routes create requests with the installed role id", async () => {
    const page = createPage([createFrame()]);
    const onCreateMacroRequested = vi.fn();
    const injector = createInjector({ onCreateMacroRequested });

    await injector.install(role, page.page as never);

    await page.binding?.({}, { type: "create" });

    expect(onCreateMacroRequested).toHaveBeenCalledWith({ roleId: "role-1" });
  });

  it("can proactively refresh installed overlay pages", async () => {
    const page = createPage([createFrame()]);
    const injector = createInjector();

    await injector.install(role, page.page as never);
    injector.refreshInstalledOverlays(role.id);

    await vi.waitFor(() => expect(page.page.evaluate).toHaveBeenCalledWith(expect.any(Function)));
  });

  it("keeps the overlay script wired for physical-code shortcuts and menu toggle", () => {
    expect(MACRO_OVERLAY_SCRIPT).toContain('event.code === "KeyM"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("event.code === trigger.code");
    expect(MACRO_OVERLAY_SCRIPT).toContain("stopImmediatePropagation");
    expect(MACRO_OVERLAY_SCRIPT).toContain("setInterval");
    expect(MACRO_OVERLAY_SCRIPT).toContain("[\"pointer-events\", \"none\"]");
    expect(MACRO_OVERLAY_SCRIPT).toContain("[\"max-width\", \"300px\"]");
    expect(MACRO_OVERLAY_SCRIPT).toContain('const hostId = "rion-studio-macro-overlay-v18"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("rion-studio-macro-overlay-v17");
    expect(MACRO_OVERLAY_SCRIPT).toContain("scriptVersion");
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

  it("renders macro menu rows with steps, shortcut, poll, and divider styling", () => {
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
    expect(MACRO_OVERLAY_SCRIPT).toContain('"><span class="macro-header"><span class="macro-title"><span class="status-dot ');
    expect(MACRO_OVERLAY_SCRIPT).toContain('class="create-row"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('data-action="create"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('await binding({ type: "create" });');
    expect(MACRO_OVERLAY_SCRIPT).toContain('</strong></span><span class="macro-action-pill ');
    expect(MACRO_OVERLAY_SCRIPT).toContain('</span></span><span class="macro-details"><span><em>');
    expect(MACRO_OVERLAY_SCRIPT).toContain("escapeHtml(text.stepsLabel)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("escapeHtml(text.shortcutLabel)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("escapeHtml(text.pollLabel)");
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      ".create-row{align-items:center;background:rgba(255,255,255,.11);border:1px solid rgba(255,255,255,.18);"
    );
    expect(MACRO_OVERLAY_SCRIPT).not.toContain(".macro-list{");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain('class="macro-list"');
    expect(macroContentIndex).toBeGreaterThan(-1);
    expect(createRowIndex).toBeGreaterThan(-1);
    expect(macroContentIndex).toBeLessThan(createRowIndex);
    expect(MACRO_OVERLAY_SCRIPT).toContain(
      ".macro-row{align-items:start;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.1);border-radius:7px;"
    );
    expect(MACRO_OVERLAY_SCRIPT).toContain("grid-template-columns:minmax(0,1fr)");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-row:hover{background:rgba(255,255,255,.095);");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-header{align-items:center;display:flex;gap:8px;justify-content:space-between;");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-title{align-items:center;display:flex;gap:8px;min-width:0;}");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-action-pill{border:1px solid rgba(255,255,255,.14);");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-details{display:grid;gap:3px;min-width:0;}");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".macro-details b{font-weight:700;min-width:0;overflow:hidden;");
    expect(MACRO_OVERLAY_SCRIPT).toContain(".panel{display:");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain(".panel{-webkit-backdrop-filter");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("backdrop-filter:blur(22px) saturate(180%)");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("background:linear-gradient(145deg,rgba(22,28,38,.36),rgba(8,12,18,.24))");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("box-shadow:0 18px 46px");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("-webkit-backdrop-filter:blur(14px) saturate(160%)");
    expect(MACRO_OVERLAY_SCRIPT).not.toContain("background:rgba(255,255,255,.075);border:1px solid rgba(255,255,255,.14)");
  });

  it("localizes overlay menu text for English and Traditional Chinese", () => {
    expect(MACRO_OVERLAY_SCRIPT).toContain("const overlayTexts = {");
    expect(MACRO_OVERLAY_SCRIPT).toContain('addMacro: "Add macro"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('addMacro: "新增巨集"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('createError: "無法開啟 Rion Studio。"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('stepsLabel: "Steps"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('shortcutLabel: "Shortcut"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('pollLabel: "Poll"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('stepsLabel: "步驟"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('shortcutLabel: "快捷鍵"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('pollLabel: "輪詢"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('keyStep: "按鍵"');
    expect(MACRO_OVERLAY_SCRIPT).toContain('everyMs: "每 {ms} ms"');
    expect(MACRO_OVERLAY_SCRIPT).toContain("language: detectOverlayLanguage()");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function getText()");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function normalizeOverlayLanguage(language)");
    expect(MACRO_OVERLAY_SCRIPT).toContain("state.language = normalizeOverlayLanguage(nextState?.language) ?? state.language;");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function detectOverlayLanguage()");
    expect(MACRO_OVERLAY_SCRIPT).toContain("function isTraditionalChineseLocale(locale)");
    expect(MACRO_OVERLAY_SCRIPT).toContain('return locales.some(isTraditionalChineseLocale) ? "zh-TW" : "en";');
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

function createInjector({
  macroManager = {
    listStatuses: vi.fn(() => []),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined)
  },
  onCreateMacroRequested
}: {
  macroManager?: {
    listStatuses: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  onCreateMacroRequested?: ReturnType<typeof vi.fn>;
} = {}): MacroOverlayInjector {
  return new MacroOverlayInjector(
    {
      listMacros: vi.fn().mockResolvedValue([assignedMacro, otherMacro])
    } as never,
    macroManager as never,
    onCreateMacroRequested
  );
}

function createPage(
  frames: Array<ReturnType<typeof createFrame>>,
  options: { rejectDuplicateBinding?: boolean } = {}
): {
  binding?: (source: unknown, request: unknown) => Promise<unknown>;
  handlers: {
    frameattached?: (frame: unknown) => void;
    framenavigated?: (frame: unknown) => void;
  };
  page: {
    addInitScript: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
    exposeBinding: ReturnType<typeof vi.fn>;
    frames: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
  };
} {
  const handlers: {
    frameattached?: (frame: unknown) => void;
    framenavigated?: (frame: unknown) => void;
  } = {};
  const result: {
    binding?: (source: unknown, request: unknown) => Promise<unknown>;
    handlers: typeof handlers;
    page: {
      addInitScript: ReturnType<typeof vi.fn>;
      evaluate: ReturnType<typeof vi.fn>;
      exposeBinding: ReturnType<typeof vi.fn>;
      frames: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
    };
  } = {
    handlers,
    page: {
      addInitScript: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(undefined),
      exposeBinding: vi.fn(async (_name: string, callback: (source: unknown, request: unknown) => Promise<unknown>) => {
        if (options.rejectDuplicateBinding && result.binding) {
          throw new Error("Binding already registered");
        }

        result.binding = callback;
      }),
      frames: vi.fn(() => frames),
      on: vi.fn((event: "frameattached" | "framenavigated", handler: (frame: unknown) => void) => {
        handlers[event] = handler;
      }),
      once: vi.fn()
    }
  };

  return result;
}

function createFrame(): {
  evaluate: ReturnType<typeof vi.fn>;
} {
  return {
    evaluate: vi.fn().mockResolvedValue(undefined)
  };
}
