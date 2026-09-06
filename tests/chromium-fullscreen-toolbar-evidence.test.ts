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
    native: {
      windowId: "window", windowGeneration: 3, topologyRevision: revision,
      projectionRevision: revision, fullscreen, revealed: mode === "revealed",
      alwaysShowToolbarInFullScreen: mode === "pinned", toolbarVisible: shown,
      nativeControlsVisible: shown, nativeWindowControlCount: shown ? 3 : 0
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
