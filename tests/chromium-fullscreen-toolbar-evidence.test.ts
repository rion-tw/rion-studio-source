import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateChromiumFullscreenToolbarRuntimeEvidence } from
  "../scripts/desktopE2eChromiumFullscreenToolbarEvidence.mjs";

function observation(mode: "normal" | "hidden" | "revealed" | "pinned", revision: number) {
  const fullscreen = mode !== "normal";
  const shown = mode !== "hidden";
  return {
    hostKind: "windows", nativeWindowHandle: "1835114", windowId: "window",
    windowGeneration: 3, topologyRevision: revision,
    presentation: fullscreen ? "fullscreen" : "normal", tabIds: ["tab"],
    workspaceTabs: [],
    native: {
      windowId: "window", windowGeneration: 3, topologyRevision: revision,
      projectionRevision: revision, fullscreen, revealed: mode === "revealed",
      alwaysShowToolbarInFullScreen: mode === "pinned", toolbarVisible: shown,
      nativeControlsVisible: shown, nativeWindowControlCount: shown ? 3 : 0,
      workspaceBackground: "material"
    },
    surfaces: [{ id: "surface", tabId: "tab", kind: "role", visible: true,
      bounds: { x: 0, y: shown ? 40 : 2, width: fullscreen ? 1024 : 960,
        height: fullscreen ? (shown ? 728 : 766) : 600 } }]
  };
}
function history() {
  return (["normal", "hidden", "revealed", "hidden", "pinned", "hidden", "normal"] as const)
    .map((mode, index) => observation(mode, index + 1));
}
function macosHistory() {
  return (["normal", "hidden", "revealed", "hidden", "pinned", "hidden", "normal"] as const)
    .map((mode, index) => {
      const original = observation(mode, index + 1);
      const { workspaceBackground: _background, ...native } = original.native;
      const { nativeWindowHandle: _handle, ...rest } = original;
      const shown = mode !== "hidden";
      return {
        ...rest,
        hostKind: "appkit",
        native: {
          ...native,
          appKit: {
            accessoryOnScreen: shown,
            accessoryVisibleHeight: shown ? 40 : 0,
            addButtonOnScreen: shown,
            fullscreenHostReady: mode !== "normal",
            presentationAutoHideToolbar: mode === "hidden",
            revealLocked: false,
            tabCloseButtonEnabledCount: 1,
            tabStripOnScreen: shown,
            toolbarPinned: mode === "pinned",
            visibleTrafficLightCount: shown ? 3 : 0,
            windowNameOnScreen: false
          }
        },
        surfaces: [{
          ...original.surfaces[0]!,
          bounds: {
            x: 0, y: mode === "pinned" ? 40 : 0,
            width: mode === "normal" ? 960 : 1024,
            height: mode === "pinned" ? 728 : mode === "normal" ? 600 : 768
          }
        }]
      };
    });
}
async function validate(observations: unknown[], platform: "macos" | "windows" = "windows") {
  const phaseDirectory = await mkdtemp(join(tmpdir(), "rion-toolbar-evidence-"));
  try {
    await writeFile(join(phaseDirectory, "electron-fullscreen-toolbar-observations.json"),
      JSON.stringify(observations));
    return await validateChromiumFullscreenToolbarRuntimeEvidence({
      phase: "chromium-fullscreen-toolbar-seed", phaseDirectory, platform
    });
  } finally { await rm(phaseDirectory, { recursive: true, force: true }); }
}

describe("Windows fullscreen toolbar aggregate evidence", () => {
  it.each(["material", "black"])("accepts the current projected %s background", async background => {
    await expect(validate(history().map(value => ({ ...value,
      native: { ...value.native, workspaceBackground: background }
    })))).resolves.toMatchObject({ pinnedAndRevealed: true });
  });
  it.each([undefined, null, "transparent", false])("rejects missing or malformed background %j", async background => {
    await expect(validate(history().map(value => ({ ...value,
      native: { ...value.native, workspaceBackground: background }
    })))).rejects.toThrow("malformed");
  });
  it("still rejects unknown native projection fields", async () => {
    await expect(validate(history().map(value => ({ ...value,
      native: { ...value.native, unexpected: true }
    })))).rejects.toThrow("malformed");
  });
  it("allows a larger fullscreen window while proving the exact toolbar inset", async () => {
    await expect(validate(history(), "windows")).resolves.toMatchObject({ autoHideObserved: true });
  });
  it("accepts legacy histories without optional HWND evidence", async () => {
    await expect(validate(history().map(({ nativeWindowHandle: _handle, ...value }) => value),
      "windows")).resolves.toMatchObject({ pinnedAndRevealed: true });
  });
  it.each(["0", "-1", "183x", 1835114, null])("rejects malformed HWND %j", async handle => {
    await expect(validate(history().map(value => ({ ...value, nativeWindowHandle: handle })),
      "windows")).rejects.toThrow("malformed");
  });
  it.each([1, 2, 3, 4, 5])("rejects wrong fullscreen height in state %i", async index => {
    const observations = history();
    observations[index]!.surfaces[0]!.bounds.height += 1;
    await expect(validate(observations, "windows")).rejects.toThrow("exact inset");
  });
  it("rejects a changed fullscreen width", async () => {
    const observations = history();
    observations[4]!.surfaces[0]!.bounds.width += 1;
    await expect(validate(observations, "windows")).rejects.toThrow("exact inset");
  });
});

describe("AppKit fullscreen toolbar aggregate evidence", () => {
  it("keeps Chromium content fixed while native auto-hide reveals", async () => {
    await expect(validate(macosHistory(), "macos"))
      .resolves.toMatchObject({ pinnedAndRevealed: true });
  });

  it("rejects content shifted by the revealed native toolbar", async () => {
    const observations = macosHistory();
    observations[2]!.surfaces[0]!.bounds.y = 40;
    await expect(validate(observations, "macos"))
      .rejects.toThrow("AppKit auto-hide moved Chromium content");
  });
});
