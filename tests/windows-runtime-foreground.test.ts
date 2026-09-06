import { describe, expect, it, vi } from "vitest";
import { parseElectronDesktopE2eFullscreenToolbarInspection } from
  "../src/electron/e2e/fullscreenToolbarInspection";
import { focusWindowsRuntimeNativeWindow } from
  "../e2e/desktop/support/windows-runtime-foreground";

describe("Windows native foreground evidence", () => {
  it("passes the exact process and HWND to the bounded native focus operation", async () => {
    const run = vi.fn(async () => "");
    await focusWindowsRuntimeNativeWindow({ processId: 42, nativeWindowHandle: "1234" },
      { platform: "win32", run });
    expect(run).toHaveBeenCalledWith(expect.any(String),
      { processId: 42, nativeWindowHandle: "1234", pointerTarget: "none" },
      { timeoutMilliseconds: 30_000 });
  });
  it.each(["reveal-edge", "content", "content-click"] as const)("submits native pointer target %s with exact identity", async pointerTarget => {
    const run = vi.fn(async () => "");
    await focusWindowsRuntimeNativeWindow({ processId: 42, nativeWindowHandle: "1234", pointerTarget },
      { platform: "win32", run });
    expect(run).toHaveBeenCalledWith(expect.any(String),
      { processId: 42, nativeWindowHandle: "1234", pointerTarget }, { timeoutMilliseconds: 30_000 });
  });
  it.each([
    { platform: "darwin", processId: 42, nativeWindowHandle: "1234" },
    { platform: "win32", processId: 0, nativeWindowHandle: "1234" },
    { platform: "win32", processId: 42, nativeWindowHandle: "0" },
    { platform: "win32", processId: 42, nativeWindowHandle: "-1" }
  ] as const)("rejects invalid evidence %j before native work", async input => {
    const run = vi.fn(async () => "");
    await expect(focusWindowsRuntimeNativeWindow(input,
      { platform: input.platform, run })).rejects.toThrow("exact Windows");
    expect(run).not.toHaveBeenCalled();
  });
  it("preserves a native foreground rejection", async () => {
    const run = vi.fn(async () => { throw new Error("foreground denied"); });
    await expect(focusWindowsRuntimeNativeWindow({ processId: 42, nativeWindowHandle: "1234" },
      { platform: "win32", run })).rejects.toThrow("foreground denied");
  });
});


const windowId = "10000000-0000-4000-8000-000000000001";
const tabId = "10000000-0000-4000-8000-000000000002";
const inspection = {
  hostKind: "windows", presentation: "normal", windowId, windowGeneration: 1,
  topologyRevision: 1, tabIds: [tabId], surfaces: [],
  native: {
    windowId, windowGeneration: 1, topologyRevision: 1, projectionRevision: 1,
    alwaysShowToolbarInFullScreen: false, fullscreen: false, revealed: false,
    toolbarVisible: true, nativeControlsVisible: true, nativeWindowControlCount: 3
  }
};

describe("fullscreen native identity parser", () => {
  it("preserves a Windows handle and accepts snapshots without the optional field", () => {
    expect(parseElectronDesktopE2eFullscreenToolbarInspection(inspection)).toEqual(inspection);
    expect(parseElectronDesktopE2eFullscreenToolbarInspection({
      ...inspection, nativeWindowHandle: "1234"
    }).nativeWindowHandle).toBe("1234");
  });
  it.each([0, "0", "-1", "1234x", null])("rejects malformed HWND %j", nativeWindowHandle => {
    expect(() => parseElectronDesktopE2eFullscreenToolbarInspection({
      ...inspection, nativeWindowHandle
    })).toThrow();
  });
});
