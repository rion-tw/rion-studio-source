import type { NativeImage } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  applyElectronApplicationIdentity,
  loadElectronApplicationIcon,
  resolveElectronApplicationIconPath,
  RION_APPLICATION_ID
} from "../src/electron/main/electronApplicationIcon";

function image(empty = false): NativeImage {
  return { isEmpty: () => empty } as unknown as NativeImage;
}

describe("Electron application icon", () => {
  it("resolves source icons in development and stable resources when packaged", () => {
    expect(resolveElectronApplicationIconPath({
      appPath: "/workspace/rion",
      isPackaged: false,
      platform: "darwin",
      resourcesPath: "/Applications/Rion Studio.app/Contents/Resources"
    })).toBe("/workspace/rion/build/icon.png");
    expect(resolveElectronApplicationIconPath({
      appPath: "C:\\workspace\\rion",
      isPackaged: true,
      platform: "win32",
      resourcesPath: "/package/resources"
    })).toBe("/package/resources/icons/rion-studio.ico");
  });

  it("fails closed when Electron cannot decode the resolved icon", () => {
    expect(() => loadElectronApplicationIcon({
      createFromPath: vi.fn(() => image(true))
    }, "/workspace/rion/build/icon.png")).toThrowError(
      expect.objectContaining({ code: "ELECTRON_APPLICATION_ICON_INVALID" })
    );
  });

  it("sets the Dock icon on macOS and Windows application identity", () => {
    const setIcon = vi.fn();
    const setAppUserModelId = vi.fn();
    const loaded = image();
    applyElectronApplicationIdentity({
      dock: { setIcon },
      setAppUserModelId
    }, "darwin", loaded);
    expect(setIcon).toHaveBeenCalledWith(loaded);
    expect(setAppUserModelId).not.toHaveBeenCalled();

    applyElectronApplicationIdentity({ setAppUserModelId }, "win32", loaded);
    expect(setAppUserModelId).toHaveBeenCalledWith(RION_APPLICATION_ID);
  });
});
