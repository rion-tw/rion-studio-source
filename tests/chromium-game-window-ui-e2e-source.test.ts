import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

describe("Chromium permanent Game Window exact replacement source", () => {
  it("uses visible creation, labeled standard-input rename, and Show actions", async () => {
    const spec = await source("e2e/desktop/specs/chromium-game-window-ui.e2e.ts");

    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-GAME-WINDOW-UI-016",
      "CHROMIUM-WINDOWS-GAME-WINDOW-UI-016",
      "button=New game window",
      "button[aria-label='Game window actions']",
      "dialog[open]",
      "label[for='rename-game-window-name']",
      "#rename-game-window-name",
      "button=Save",
      "button[aria-label='Show']",
      "electronDesktopE2eGameWindowRuntime",
      "coreTabIds: []",
      "nativeTabIds: []",
      'hostKind).toBe("appkit-chromium")',
      'hostKind).toBe("bundled-chromium")'
    ]) {
      expect(spec).toContain(marker);
    }
    expect(spec).not.toContain("navigate(");
    expect(spec).not.toContain("browser.execute(");
    expect(spec).not.toContain("browser.executeAsync(");
    expect(spec).not.toContain('rendererCall("createGameWindow"');
    expect(spec).not.toContain('rendererCall("updateGameWindow"');
    expect(spec).not.toContain('rendererCall("showGameWindow"');
    expect(new Set(
      [...spec.matchAll(/rendererCall\("([^"]+)"/gu)].map((match) => match[1])
    )).toEqual(new Set(["listGameWindows"]));
  });

  it("keeps the E2E identity path read-only and validates exact Core/native fences", async () => {
    const [bridge, e2eMain, evidence, runner] = await Promise.all([
      source("src/electron/e2e/desktopE2eBridge.ts"),
      source("src/electron/e2e/index.ts"),
      source("scripts/desktopE2eChromiumGameWindowEvidence.mjs"),
      source("scripts/runDesktopE2e.mjs")
    ]);

    expect(bridge).toContain('action: "gameWindowRuntime"');
    expect(bridge).toContain("readGameWindowRuntime");
    expect(e2eMain).toContain('core.invoke({ type: "appSnapshot" })');
    expect(e2eMain).toContain("logical.windowGeneration !== native.windowGeneration");
    expect(e2eMain).toContain("logical.revision !== native.topologyRevision");
    expect(e2eMain).toContain("browserWindow.tabIds");
    expect(e2eMain).not.toContain("setInterval");
    expect(evidence).toContain("retained AppKit Game Window identity is not exact");
    expect(evidence).toContain("sameValue(runtime.coreTabIds, [])");
    expect(evidence).toContain("sameValue(runtime.nativeTabIds, [])");
    expect(evidence).toContain('runtime.appKitStatusPresentation === "ready"');
    expect(evidence).toContain('runtime.nativeDisplay.presentation === "normal"');
    expect(runner).toContain('"chromium-game-window-ui-restart", ["chromium-game-window-ui-seed"]');
    expect(runner).toContain('"chromium-game-window-ui-lifecycle"');
  });

  it("keeps separate AppKit and Windows replacement verdicts", async () => {
    const manifest = JSON.parse(await source("docs/e2e-coverage.json")) as {
      journeys: Array<Record<string, unknown>>;
    };
    const journeys = manifest.journeys.filter((journey) =>
      journey.coverageGroup === "chromium-v23-game-window-ui"
    );

    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([
      ["macos"],
      ["windows"]
    ]);
    for (const journey of journeys) {
      expect(journey.replaces).toEqual(["GAME-WINDOWS-UI-001"]);
      expect(journey.outcomes).toEqual(["success", "restart"]);
      expect(journey.phases).toEqual([
        "chromium-game-window-ui-seed",
        "chromium-game-window-ui-restart"
      ]);
    }
  });
});
