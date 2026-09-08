import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop E2E build isolation", () => {

  it("keeps renderer reload readiness probes retryable", async () => {
    const source = await readFile("e2e/desktop/support/ui.ts", "utf8");

    expect(source).toContain("const RENDERER_PROBE_TIMEOUT_MS = 5_000;");
    expect(source).toContain("const RENDERER_READY_TIMEOUT_MS = 30_000;");
    expect(source).toContain("await browser.getTimeouts()");
    expect(source).toContain("await browser.setTimeout({ script: RENDERER_PROBE_TIMEOUT_MS })");
    expect(source).toContain("await browser.setTimeout({ script: previousScriptTimeout })");
    expect(source).toContain("lastProbeError = error;");
    expect(source).toContain("return false;");
    expect(source).toContain('localStorage.getItem(storageKey) !== "en"');
    expect(source).toContain('document.documentElement.lang !== "en"');
    expect(source).toContain("await browser.refresh()");
    expect(source).not.toContain("window.location.reload()");
  });

  it("fences runtime projection waits to exact tab visibility", async () => {
    const [journal] = await Promise.all([
      readFile("e2e/desktop/support/renderer-events.ts", "utf8")
    ]);

    expect(journal).toContain("hidden?: boolean;");
    expect(journal).toContain("tabId?: string;");
    expect(journal).toContain("journal.runtimeStates.length - 1");
    expect(journal).toContain("if (entry.sequence <= afterSequence) continue;");
    expect(journal).toContain("candidate.id === waitRequest.tabId");
    expect(journal).toContain("tab?.hidden !== waitRequest.hidden");
  });

  it("keeps router-native test navigation out of production renderer assets", async () => {
    const [entry, renderer] = await Promise.all([
      readFile("src/renderer/src/main.tsx", "utf8"),
      readFile("src/renderer/src/app/bootstrapRenderer.tsx", "utf8")
    ]);
    const isolationCheck = await readFile("scripts/verifyDesktopE2eIsolation.mjs", "utf8");

    expect(renderer).toContain("if (__RION_DESKTOP_E2E__)");
    expect(entry).toContain("prepareElectronRenderer");
    expect(renderer).toContain("window.__rionStudioDesktopE2eNavigate");
    expect(renderer).toContain("router.navigate(path)");
    expect(isolationCheck).toContain("__rionStudioDesktopE2eNavigate");
  });

  it("negative-gates Electron E2E preconditions from every production bundle", async () => {
    const isolationCheck = await readFile("scripts/verifyDesktopE2eIsolation.mjs", "utf8");

    expect(isolationCheck).toContain('resolve(root, "out", "main")');
    expect(isolationCheck).toContain('resolve(root, "out", "preload")');
    expect(isolationCheck).toContain("rion:e2e:invoke");
    expect(isolationCheck).toContain("rionStudioDesktopE2e");
    expect(isolationCheck).toContain("retainedV22Precondition");
  });

  it("opens entity menus through the visible WebDriver trigger", async () => {
    const source = await readFile("e2e/desktop/support/ui.ts", "utf8");
    const helper = source.slice(source.indexOf("export async function clickEntityMenuAction"));

    expect(helper.indexOf("trigger.scrollIntoView"))
      .toBeLessThan(helper.indexOf("trigger.waitForDisplayed"));
    expect(helper.indexOf("trigger.waitForDisplayed"))
      .toBeLessThan(helper.indexOf("trigger.moveTo"));
    expect(helper.indexOf("trigger.moveTo"))
      .toBeLessThan(helper.indexOf("trigger.waitForClickable"));
    expect(helper.indexOf("trigger.waitForClickable"))
      .toBeLessThan(helper.indexOf('browser.action("pointer"'));
    expect(helper).toContain('trigger.getAttribute("data-state")');
    expect(helper).toContain('.down("left")');
    expect(helper).toContain('.up("left")');
    expect(helper).toContain('browser.action("key").down(Key.Enter).up(Key.Enter).perform()');

    expect(helper).not.toContain("dispatchEvent");
  });

  it("foregrounds the exact AppKit drag windows before posting pointer input", async () => {
    const source = await readFile(
      "crates/rion-appkit/native/macos/RionRuntimeTabsController/06_fullscreen.mm",
      "utf8"
    );
    const drag = source.slice(
      source.indexOf("- (BOOL)performDesktopE2EDragForTabIdentifier:"),
      source.indexOf("#endif", source.indexOf(
        "- (BOOL)performDesktopE2EDragForTabIdentifier:"
      ))
    );

    expect(drag).toContain("[targetWindow orderFront:nil]");
    expect(drag).toContain("[sourceWindow makeKeyAndOrderFront:nil]");
    expect(drag.indexOf("[sourceWindow makeKeyAndOrderFront:nil]"))
      .toBeLessThan(drag.indexOf("NSEvent *down"));
    expect(drag).toContain("!sourceWindow.isVisible || !targetWindow.isVisible");
  });

  it("reasserts retained AppKit focus after Chromium attachment drains", async () => {
    const bridge = await readFile(
      "crates/rion-appkit/native/macos/RionRuntimeTabsController/02_c_abi_bridge.mm",
      "utf8"
    );
    const focus = bridge.slice(
      bridge.indexOf("bool rion_runtime_tabs_set_window_interaction("),
      bridge.indexOf("bool rion_runtime_tabs_set_reveal_locked(")
    );

    expect(focus).toContain("dispatch_async(dispatch_get_main_queue()")
    expect(focus).toContain("!NSApp.isActive")
    expect(focus).toContain("[focusedWindow makeKeyAndOrderFront:nil]")
    expect(focus.indexOf("[window makeKeyAndOrderFront:nil]"))
      .toBeLessThan(focus.indexOf("dispatch_async(dispatch_get_main_queue()"));
  });
});
