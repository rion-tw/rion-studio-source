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

    expect(activation).toContain('if (phase !== "ready")');
    expect(activation).toContain("tab-launch-phase:${tabId}:ready");
    expect(activation).not.toContain("tab-launch-phase:${tabId}:essentialReady");
  });

  it("fences a visible hidden-tab show on its exact launch terminal", async () => {
    const source = await readFile(
      new URL("../e2e/desktop/specs/cross-domain-runtime.e2e.ts", import.meta.url),
      "utf8"
    );
    const showSource = source.slice(
      source.indexOf("async function showSourceFromVisibleUi("),
      source.indexOf("async function forceTerminateCurrentProcess(")
    );

    expect(showSource).toContain("waitForRuntimeLaunchTerminal(control, tab.sourceId, tab.type)");
    expect(showSource).toContain('rendererCall("getEmbeddedRuntimeState")');
    expect(showSource).not.toContain("waitForRuntimeProjection");
  });
});
