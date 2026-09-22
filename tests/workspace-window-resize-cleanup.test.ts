import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../scripts/encodedPowerShell.mjs", () => ({ runEncodedPowerShellJson: mocks.run }));
vi.mock("node:fs/promises", () => ({ appendFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("../e2e/desktop/support/electron-driver", () => ({
  electronDesktopE2eProbe: async () => ({ processId: 123, platform: "windows" })
}));
vi.mock("../e2e/desktop/support/windows-runtime-foreground", () => ({
  focusWindowsRuntimeNativeWindow: vi.fn()
}));
vi.mock("../e2e/desktop/support/native-application-actions", () => ({
  focusVisibleMacosAppKitRuntime: vi.fn()
}));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each([false, true])("retains resize evidence when a retired HWND rejects cleanup (primary failure: %s)", async (failWhileHeld) => {
  // This helper belongs to the separate WDIO compilation graph.
  const { resizeWorkspaceWindow } = await vi.importActual<{
    resizeWorkspaceWindow(input: {
      inspection: { windowId: string; nativeWindowHandle: string };
      edge: "left"; moves: { x: number; y: number }[]; whileHeld: () => Promise<void>;
    }): Promise<void>;
  }>("../e2e/desktop/support/workspace-window-resize");
  vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", process.cwd());
  const primary = new Error("Core/browser ownership diverged");
  const cleanup = new Error("exact resize HWND changed");
  mocks.run.mockImplementation(async (_script: string, payload: { phase: string }) => {
    if (payload.phase === "end") throw cleanup;
    return JSON.stringify({ x: 100, y: 100, width: 900, height: 600,
      windowX: 0, windowY: 0, minimumWidth: 640, minimumHeight: 480 });
  });
  const action = resizeWorkspaceWindow({
    inspection: { windowId: "window", nativeWindowHandle: "456" },
    edge: "left", moves: [{ x: 0, y: 0 }],
    whileHeld: async () => { if (failWhileHeld) throw primary; }
  });
  if (failWhileHeld) await expect(action).rejects.toMatchObject({ errors: [primary, cleanup] });
  else await expect(action).rejects.toBe(cleanup);
  expect(mocks.run.mock.calls.map(call => call[1].phase)).toEqual(["start", "move", "end"]);
});
