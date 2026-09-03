import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { windowGestureMode } from
  "../src/renderer/src/app/windowGestureMode";

describe("desktop shell window gesture mode", () => {
  it("uses Electron native regions on macOS and Windows", () => {
    expect(windowGestureMode("mac", "electron")).toBe("native-non-client");
    expect(windowGestureMode("windows", "electron")).toBe("native-non-client");
  });

  it("retains the v22 AppKit drag bridge only in the Tauri macOS shell", () => {
    expect(windowGestureMode("mac", "tauri")).toBe("appkit-bridge");
    expect(windowGestureMode("windows", "tauri")).toBe("native-non-client");
    expect(windowGestureMode("linux", "electron")).toBe("unavailable");
    expect(windowGestureMode("linux", "tauri")).toBe("unavailable");
  });

  it("binds the shell identity at each renderer build boundary", async () => {
    const [electron, tauri, declarations] = await Promise.all([
      readFile("electron.vite.config.ts", "utf8"),
      readFile("vite.tauri.config.ts", "utf8"),
      readFile("src/renderer/src/global.d.ts", "utf8")
    ]);

    expect(electron).toContain(
      '__RION_DESKTOP_SHELL__: JSON.stringify("electron")'
    );
    expect(tauri).toContain(
      '__RION_DESKTOP_SHELL__: JSON.stringify("tauri")'
    );
    expect(declarations).toContain(
      'const __RION_DESKTOP_SHELL__: "electron" | "tauri"'
    );
  });
});
