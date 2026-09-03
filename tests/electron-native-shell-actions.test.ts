import { describe, expect, it, vi } from "vitest";

import { ElectronNativeShellActions } from
  "../src/electron/main/electronNativeShellActions";
import type { CoreCommand } from "../src/shared/generated";

function harness() {
  const invoke = vi.fn(async (command: CoreCommand) => {
    switch (command.type) {
      case "chromeProfileDefaultPath":
        return "/Users/test/Library/Application Support/Google/Chrome";
      case "logsStatus":
        return { directory: "/Users/test/Library/Logs/Rion Studio" };
      default:
        return { command };
    }
  });
  const chooseDirectory = vi.fn<() => Promise<string | null>>(
    async () => "/Users/test/Chrome"
  );
  const chooseFile = vi.fn<() => Promise<string | null>>(
    async () => "/Users/test/import.json"
  );
  const saveFile = vi.fn<() => Promise<string | null>>(
    async () => "/Users/test/export.json"
  );
  const openPath = vi.fn(async () => "");
  const openExternal = vi.fn(async () => undefined);
  const actions = new ElectronNativeShellActions({
    core: { invoke: invoke as never },
    chooseDirectory,
    chooseFile,
    saveFile,
    openPath,
    openExternal
  });
  return {
    actions,
    chooseDirectory,
    chooseFile,
    invoke,
    openExternal,
    openPath,
    saveFile
  };
}

describe("Electron native shell actions", () => {
  it("keeps portable file selection in the shell and data authority in Core", async () => {
    const { actions, invoke, saveFile } = harness();
    const result = await actions.exportPortableData();

    expect(saveFile).toHaveBeenCalledWith({
      title: "Export Rion Studio JSON",
      defaultName: "rion-studio-export.json",
      extension: "json"
    });
    expect(invoke).toHaveBeenCalledWith({
      type: "portableExportTo",
      path: "/Users/test/export.json",
      selection: {
        games: true,
        roles: true,
        launchWorkspaces: true,
        gameWindows: true,
        macros: true,
        preferences: true
      }
    });
    expect(result).toEqual(expect.any(Object));
  });

  it("uses exact selected paths for portable and Chrome previews", async () => {
    const { actions, chooseDirectory, invoke } = harness();

    await actions.previewPortableImport();
    await actions.previewChromeProfileImport();

    expect(chooseDirectory).toHaveBeenCalledWith({
      title: "Choose Chrome User Data",
      defaultPath: "/Users/test/Library/Application Support/Google/Chrome"
    });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      { type: "portablePreviewFile", path: "/Users/test/import.json" },
      { type: "chromeProfileDefaultPath" },
      { type: "chromeProfilePreview", sourceUserDataDir: "/Users/test/Chrome" }
    ]);
  });

  it("treats canceled dialogs as an exact null outcome without invoking Core", async () => {
    const state = harness();
    state.saveFile.mockResolvedValueOnce(null);
    state.chooseFile.mockResolvedValueOnce(null);
    state.chooseDirectory.mockResolvedValueOnce(null);

    await expect(state.actions.exportPortableData()).resolves.toBeNull();
    await expect(state.actions.previewPortableImport()).resolves.toBeNull();
    await expect(state.actions.previewChromeProfileImport()).resolves.toBeNull();
    expect(state.invoke).toHaveBeenCalledOnce();
    expect(state.invoke).toHaveBeenCalledWith({ type: "chromeProfileDefaultPath" });
  });

  it("reveals only Core's absolute log directory and opens the fixed release page", async () => {
    const { actions, openExternal, openPath } = harness();

    await actions.revealLogs();
    await actions.openUpdateDownload();

    expect(openPath).toHaveBeenCalledWith(
      "/Users/test/Library/Logs/Rion Studio"
    );
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/rion-tw/rion-studio/releases/latest"
    );
  });

  it("fails closed on relative native paths and operating-system reveal errors", async () => {
    const invalid = harness();
    invalid.saveFile.mockResolvedValueOnce("relative/export.json");
    await expect(invalid.actions.exportPortableData()).rejects.toMatchObject({
      code: "ELECTRON_NATIVE_PATH_INVALID"
    });

    const reveal = harness();
    reveal.openPath.mockResolvedValueOnce("permission denied");
    await expect(reveal.actions.revealLogs()).rejects.toMatchObject({
      code: "ELECTRON_REVEAL_LOGS_FAILED"
    });
  });
});
