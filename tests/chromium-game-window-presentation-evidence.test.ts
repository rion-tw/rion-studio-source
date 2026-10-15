import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  validateChromiumGameWindowRuntimeEvidence,
  validateChromiumGameWindowSqliteEvidence
} from "../scripts/desktopE2eChromiumGameWindowEvidence.mjs";

type Platform = "macos" | "windows";
const windowId = "12de130f-7b29-4ce4-98a4-7e75a4afdd34";
const normalBounds = { x: 64, y: 64, width: 960, height: 640 };
const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

function native(platform: Platform, presentation: string) {
  return {
    appKitIdentity: platform === "macos" ? {
      launchGeneration: "bb9d88f6-7345-4c7b-9d8a-126e464758d0",
      logicalWindowId: windowId,
      nativeGeneration: 2
    } : null,
    appKitStatusPresentation: platform === "macos" ? "ready" : null,
    coreTabIds: [], focused: true,
    hostKind: platform === "macos" ? "appkit-chromium" : "bundled-chromium",
    nativeDisplay: { bounds: presentation === "normal" ? normalBounds : workArea,
      displayId: 1, presentation, scaleFactor: 1, workArea },
    nativeTabIds: [], parentNativeHostId: 5, topologyRevision: 3,
    visible: true, windowGeneration: 2, windowId
  };
}

function saved(presentation: string, bounds = normalBounds) {
  return { id: windowId, name: "Chromium E2E Game Window", tabs: [],
    placement: { normalBounds: bounds, savedWorkArea: workArea, presentation },
    targetDisplay: { id: 1 } };
}

function history(platform: Platform, restart = false) {
  const baseline = platform === "windows" ? "maximized" : "fullscreen";
  const stages = restart ? ["restart-restored"] : [
    "normal-baseline", "fullscreen-applied", "fullscreen-closed", "fullscreen-reopened",
    "normal-restored", "maximized-applied", "maximized-closed", "maximized-reopened",
    ...(platform === "macos" ? ["normal-after-maximize", "fullscreen-baseline"] : [])
  ];
  return stages.map(stage => {
    const presentation = stage.startsWith("normal-") ? "normal"
      : stage.startsWith("fullscreen-") ? "fullscreen"
        : stage.startsWith("maximized-") ? "maximized" : baseline;
    return { stage, saved: saved(presentation),
      runtime: stage.endsWith("-closed") ? null : native(platform, presentation) };
  });
}

function initialShow(platform: Platform) {
  return { windowId, requestedSavedPlacement: saved("normal").placement,
    savedWindow: saved("normal"), runtime: native(platform, "normal") };
}

async function validate(
  platform: Platform,
  stages: ReturnType<typeof history>,
  restart = false,
  currentRuntime = native(platform, platform === "windows" ? "maximized" : "fullscreen"),
  show = initialShow(platform)
) {
  const phaseDirectory = await mkdtemp(join(tmpdir(), "rion-window-presentation-"));
  try {
    await writeFile(join(phaseDirectory, "game-window-presentation-stages.json"),
      JSON.stringify(stages));
    await writeFile(join(phaseDirectory, "electron-game-window-runtime-observations.json"),
      JSON.stringify([{ windowId, currentRuntime }]));
    if (!restart) await writeFile(join(phaseDirectory, "game-window-initial-show.json"), JSON.stringify(show));
    return await validateChromiumGameWindowRuntimeEvidence({ platform, phaseDirectory,
      phase: `chromium-game-window-ui-${restart ? "restart" : "seed"}` });
  } finally {
    await rm(phaseDirectory, { recursive: true, force: true });
  }
}

describe("Game Window presentation close/reopen evidence", () => {
  it.each(["macos", "windows"] as const)("accepts the exact %s native and saved lifecycle", async platform => {
    const presentation = platform === "windows" ? "maximized" : "fullscreen";
    await expect(validate(platform, history(platform))).resolves.toMatchObject({
      presentation, savedNormalBounds: normalBounds,
      presentationStages: history(platform).map(({ stage }) => stage)
    });
    await expect(validate(platform, history(platform, true), true)).resolves.toMatchObject({
      presentation, presentationStages: ["restart-restored"]
    });
  });

  it.each(["macos", "windows"] as const)("rejects %s native fullscreen when saved remained normal", async platform => {
    const stages = history(platform);
    stages[1]!.saved.placement.presentation = "normal";
    await expect(validate(platform, stages)).rejects.toThrow(
      "fullscreen-applied lost the saved presentation or normal bounds"
    );
  });

  it.each(["macos", "windows"] as const)("rejects %s maximized bounds replacing retained normal bounds", async platform => {
    const stages = history(platform);
    stages[5]!.saved.placement.normalBounds = workArea;
    await expect(validate(platform, stages)).rejects.toThrow(
      "maximized-applied lost the saved presentation or normal bounds"
    );
  });

  it("rejects AppKit maximize when only the native state changed", async () => {
    const stages = history("macos");
    stages[5]!.saved.placement.presentation = "normal";
    await expect(validate("macos", stages)).rejects.toThrow(
      "maximized-applied lost the saved presentation or normal bounds"
    );
  });

  it("requires authoritative native retirement before Show", async () => {
    const stages = history("windows");
    stages[6]!.runtime = native("windows", "maximized");
    await expect(validate("windows", stages)).rejects.toThrow(
      "maximized-closed did not retire the exact native owner"
    );
  });

  it("rejects a normal native window after clean restart", async () => {
    await expect(validate("windows", history("windows", true), true,
      native("windows", "normal"))).rejects.toThrow("lacks exact focused Core/native ownership");
  });

  it("rejects skipped fullscreen close/reopen stages", async () => {
    const stages = history("macos");
    stages.splice(2, 1);
    await expect(validate("macos", stages)).rejects.toThrow("stages are incomplete or reordered");
  });

  it.each(["macos", "windows"] as const)("accepts %s native fitting only after a committed placement revision", async platform => {
    const show = initialShow(platform);
    show.requestedSavedPlacement.normalBounds = { ...normalBounds, height: 648 };
    show.runtime.topologyRevision = 2;
    await expect(validate(platform, history(platform), false, undefined, show)).resolves.toMatchObject({
      initialNativeFit: true, initialTopologyRevision: 2
    });
    show.runtime.topologyRevision = 1;
    await expect(validate(platform, history(platform), false, undefined, show)).rejects.toThrow(
      "accepted native fitting without a committed placement revision"
    );
  });

  it("accepts unchanged geometry at the first revision and compares rectangle values independent of key order", async () => {
    const show = initialShow("macos");
    show.runtime.topologyRevision = 1;
    show.runtime.nativeDisplay.bounds = { height: 640, width: 960, y: 64, x: 64 };
    await expect(validate("macos", history("macos"), false, undefined, show)).resolves.toMatchObject({
      initialNativeFit: false, initialTopologyRevision: 1
    });
  });

  it.each(["window", "generation", "parent", "bounds", "display", "appkit"] as const)(
    "rejects a fitted first Show with mismatched %s identity or geometry", async field => {
      const show = initialShow("macos");
      if (field === "window") show.runtime.windowId = "another-window";
      if (field === "generation") show.runtime.windowGeneration += 1;
      if (field === "parent") show.runtime.parentNativeHostId += 1;
      if (field === "bounds") show.runtime.nativeDisplay.bounds = { ...normalBounds, height: 648 };
      if (field === "display") show.runtime.nativeDisplay.displayId = 2;
      if (field === "appkit") show.runtime.appKitIdentity = {
        ...show.runtime.appKitIdentity!, logicalWindowId: "another-window"
      };
      await expect(validate("macos", history("macos"), false, undefined, show)).rejects.toThrow(
        "initial visible Show lacks exact accepted Core/native placement and owner fences"
      );
    });

  it("rejects malformed requested bounds before classifying any native fit", async () => {
    const show = initialShow("macos");
    show.requestedSavedPlacement.normalBounds = { ...normalBounds, width: 0 };
    await expect(validate("macos", history("macos"), false, undefined, show)).rejects.toThrow(
      "initial visible Show lost the requested or accepted empty-window placement"
    );
  });
});

describe("Game Window saved presentation SQLite restart evidence", () => {
  function entities(presentation: string, bounds = normalBounds) {
    const window = saved(presentation, bounds);
    return { gameWindows: [{ id: window.id, name: window.name, payload: window }] };
  }

  it.each(["maximized", "fullscreen"])("preserves the exact saved %s placement", presentation => {
    expect(validateChromiumGameWindowSqliteEvidence("chromium-game-window-ui-seed",
      entities(presentation))).toMatchObject({ savedPresentation: presentation });
    expect(validateChromiumGameWindowSqliteEvidence("chromium-game-window-ui-restart",
      entities(presentation))).toMatchObject({ savedPresentation: presentation, restartVerified: true });
  });

  it("rejects changed normal bounds after restart", () => {
    validateChromiumGameWindowSqliteEvidence("chromium-game-window-ui-seed", entities("maximized"));
    expect(() => validateChromiumGameWindowSqliteEvidence("chromium-game-window-ui-restart",
      entities("maximized", workArea))).toThrow("restart changed the permanent Game Window identity or placement");
  });

  it("rejects a seed that did not persist either presentation", () => {
    expect(() => validateChromiumGameWindowSqliteEvidence("chromium-game-window-ui-seed",
      entities("normal"))).toThrow("permanent Chromium Game Window did not remain empty");
  });
});
