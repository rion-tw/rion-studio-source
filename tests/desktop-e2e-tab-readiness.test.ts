import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("desktop E2E restored tab readiness", () => {
  it("waits for full page readiness before a later window close checkpoint", async () => {
    const source = await readFile(
      new URL("../e2e/desktop/specs/tab-cleanup.e2e.ts", import.meta.url),
      "utf8"
    );
    const activation = source.slice(
      source.indexOf("async function activateTab("),
      source.indexOf("async function closeTab(")
    );

    expect(activation).toContain("const activated = await windowSnapshot(windowId)");
    expect(activation).toContain(
      'activated.kernel?.tabs.find((tab) => tab.tabId === tabId)?.launchPhase !== "ready"'
    );
    expect(activation).toContain("tab-launch-phase:${tabId}:ready");
    expect(activation).not.toContain("tab-launch-phase:${tabId}:essentialReady");
    expect(activation.indexOf('kind: "runtime-tab-activation-terminal"'))
      .toBeLessThan(activation.indexOf("const activated = await windowSnapshot(windowId)"));
    expect(activation.indexOf("const activated = await windowSnapshot(windowId)"))
      .toBeLessThan(activation.indexOf("tab-launch-phase:${tabId}:ready"));
  });

  it("fences hidden-tab visibility after the exact launch terminal", async () => {
    const source = await readFile(
      new URL("../e2e/desktop/specs/cross-domain-runtime.e2e.ts", import.meta.url),
      "utf8"
    );
    const showSource = source.slice(
      source.indexOf("async function showSourceFromVisibleUi("),
      source.indexOf("async function forceTerminateCurrentProcess(")
    );

    expect(showSource).toContain("hiddenBeforeLaunch");
    expect(showSource).toContain("hiddenBeforeLaunch ? await rendererEventCursor() : undefined");
    expect(showSource).toContain("waitForRuntimeLaunchTerminal(control, tab.sourceId, tab.type)");
    expect(showSource).toContain('rendererCall("getEmbeddedRuntimeState")');
    expect(showSource).toContain("waitForRuntimeProjection({");
    expect(showSource).toContain("hidden: false");
    expect(showSource.indexOf("waitForRuntimeLaunchTerminal"))
      .toBeLessThan(showSource.indexOf("waitForRuntimeProjection({"));
  });

  it("prearms source-window persistence before a detach terminal can overtake it", async () => {
    const source = await readFile(
      new URL("../e2e/desktop/specs/cross-domain-runtime.e2e.ts", import.meta.url),
      "utf8"
    );
    const detachSource = source.slice(
      source.indexOf("const sourcePersistenceCursor ="),
      source.indexOf("await waitForActiveTabsReady();", source.indexOf("const sourcePersistenceCursor ="))
    );

    expect(detachSource).toContain("const sourcePersistenceCursor = (await probe()).latestSequence");
    expect(detachSource).toContain('action: "moveToNewWindow"');
    expect(detachSource).toContain("afterSequence: sourcePersistenceCursor");
    expect(detachSource).not.toContain("afterSequence: sourceRetirement.sequence");
    expect(detachSource).toContain("afterSequence: sourcePersisted.sequence");
    expect(detachSource).toContain(".activeTabId !== null");
    expect(detachSource.indexOf("const sourcePersistenceCursor ="))
      .toBeLessThan(detachSource.indexOf('action: "moveToNewWindow"'));
  });

  it("accepts either authoritative deadline that can claim navigation restart", async () => {
    const source = await readFile(
      new URL("../e2e/desktop/specs/cross-domain-runtime.e2e.ts", import.meta.url),
      "utf8"
    );
    const recovery = source.slice(
      source.indexOf("const recoveryMacroCursor ="),
      source.indexOf("const terminalInput =", source.indexOf("const recoveryMacroCursor ="))
    );

    expect(recovery).toContain('"navigation-page-ready-failed"');
    expect(recovery).toContain('"page-finish-deadline"');
    expect(recovery).toContain("toContain((restartRequired.details as { reason?: string }).reason)");
  });
});
