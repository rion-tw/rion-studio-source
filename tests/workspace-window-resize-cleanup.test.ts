import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn(), swift: vi.fn(), write: vi.fn(), append: vi.fn(),
  constraints: vi.fn(), probe: vi.fn() }));
vi.mock("../scripts/encodedPowerShell.mjs", () => ({ runEncodedPowerShellJson: mocks.run }));
vi.mock("node:fs/promises", () => ({ appendFile: mocks.append, writeFile: mocks.write }));
vi.mock("../e2e/desktop/support/electron-driver", () => ({
  electronDesktopE2eProbe: mocks.probe
}));
vi.mock("../e2e/desktop/support/compiled-workspace-swift", () => ({ runWorkspaceSwift: mocks.swift }));
vi.mock("../e2e/desktop/support/macos-runtime-window-constraints", () => ({
  readMacosRuntimeWindowConstraints: mocks.constraints
}));
vi.mock("../e2e/desktop/support/windows-runtime-foreground", () => ({
  focusWindowsRuntimeNativeWindow: vi.fn()
}));
vi.mock("../e2e/desktop/support/native-application-actions", () => ({
  focusVisibleMacosAppKitRuntime: vi.fn()
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.probe.mockResolvedValue({ processId: 123, platform: "windows" });
});
afterEach(() => vi.unstubAllEnvs());

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
      windowX: 0, windowY: 0, minimumWidth: 640, minimumHeight: 480,
      dragFullWindows: false });
  });
  const action = resizeWorkspaceWindow({
    inspection: { windowId: "window", nativeWindowHandle: "456" },
    edge: "left", moves: [{ x: 0, y: 0 }],
    whileHeld: async () => { if (failWhileHeld) throw primary; }
  });
  if (failWhileHeld) await expect(action).rejects.toMatchObject({ errors: [primary, cleanup] });
  else await expect(action).rejects.toBe(cleanup);
  expect(mocks.run.mock.calls.map(call => call[1].phase)).toEqual(["start", "move", "end"]);
  expect(mocks.run.mock.calls[2]?.[1]).toMatchObject({ restoreDragFullWindows: false });
  expect(mocks.constraints).not.toHaveBeenCalled();
});

const macInspection = { windowId: "window", hostKind: "appkit" };
type Frame = { x: number; y: number; width: number; height: number; windowX: number; windowY: number;
  minimumWidth: number; minimumHeight: number };
const loadResize = () => vi.importActual<{
  resizeWorkspaceWindow(input: { inspection: typeof macInspection; edge: "bottomRight";
    moves: { x: number; y: number }[]; rapid?: boolean; requireRequestedFrame: "all";
    whileHeld: (step: number, frame: Frame, initialFrame: Frame) => Promise<void> }): Promise<void>;
}>("../e2e/desktop/support/workspace-window-resize");
type Request = { phase: string; expected: { x: number; y: number } | null; x: number; y: number };
const lastRequest = () => JSON.parse(mocks.write.mock.calls.at(-1)![1]) as Request;
const minimum = { minimumWidth: 640, minimumHeight: 520, parentNativeHostId: 731,
  windowId: "window", windowGeneration: 2, topologyRevision: 5,
  appKitIdentity: { launchGeneration: "launch", logicalWindowId: "window", nativeGeneration: 3 } };

it.each([false, true])("acknowledges every macOS %s range move against the live native minimum", async rapid => {
  const { resizeWorkspaceWindow } = await loadResize();
  vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", process.cwd());
  mocks.probe.mockResolvedValue({ processId: 123, platform: "macos" });
  mocks.constraints.mockResolvedValue(minimum);
  mocks.swift.mockImplementation(async () => {
    const request = lastRequest();
    return JSON.stringify({ x: request.phase === "start" ? 983 : request.x,
      y: request.phase === "start" ? 699 : request.y, windowX: 56, windowY: 31,
      width: request.expected?.x ?? 935, height: request.expected?.y ?? 676 });
  });
  const held: Frame[] = [];
  await resizeWorkspaceWindow({ inspection: macInspection, edge: "bottomRight", rapid,
    requireRequestedFrame: "all", moves: rapid ? [{ x: -96, y: -72 }, { x: 0, y: 0 }] : [
      { x: -295, y: -236 }, { x: -64, y: -48 }, { x: 0, y: 0 }],
    whileHeld: async (_step, frame, initial) => {
      expect(initial).toMatchObject({ width: 935, height: 676, minimumWidth: 640, minimumHeight: 520 });
      held.push(frame);
    }
  });
  const requests = mocks.write.mock.calls.map(call => JSON.parse(call[1]) as Request);
  expect(requests.map(request => request.phase)).toEqual(rapid ? ["start", "move", "move", "end"] :
    ["start", "move", "move", "move", "end"]);
  const expected = rapid ? [{ x: 839, y: 604 }, { x: 935, y: 676 }] :
    [{ x: 640, y: 520 }, { x: 871, y: 628 }, { x: 935, y: 676 }];
  expect(requests.filter(request => request.phase === "move").map(request => request.expected)).toEqual(expected);
  expect(held.map(frame => ({ x: frame.width, y: frame.height }))).toEqual(expected);
  const evidence = mocks.append.mock.calls.map(call => JSON.parse(call[1]));
  for (const event of evidence) expect(event.constraints).toEqual(minimum);
  expect(mocks.constraints).toHaveBeenCalledOnce();
  expect(mocks.constraints).toHaveBeenCalledWith({ inspection: macInspection, processId: 123 });
  expect(mocks.run).not.toHaveBeenCalled();
});

it("retains the native minimum acknowledgement failure and releases the held macOS pointer", async () => {
  const { resizeWorkspaceWindow } = await loadResize();
  vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", process.cwd());
  mocks.probe.mockResolvedValue({ processId: 123, platform: "macos" });
  mocks.constraints.mockResolvedValue(minimum);
  const failure = new Error("native resize did not reach requested frame: 640x520, actual 690x520");
  mocks.swift.mockImplementation(async () => {
    if (lastRequest().phase === "move") throw failure;
    return JSON.stringify({ x: 983, y: 699, windowX: 56, windowY: 31, width: 935, height: 676 });
  });
  const whileHeld = vi.fn();
  await expect(resizeWorkspaceWindow({ inspection: macInspection, edge: "bottomRight",
    requireRequestedFrame: "all", moves: [{ x: -295, y: -236 }], whileHeld })).rejects.toBe(failure);
  expect(mocks.write.mock.calls.map(call => JSON.parse(call[1]).phase)).toEqual(["start", "move", "end"]);
  expect(whileHeld).not.toHaveBeenCalled();
});

it("rejects stale macOS constraints before pressing or dragging the native pointer", async () => {
  const { resizeWorkspaceWindow } = await loadResize();
  mocks.probe.mockResolvedValue({ processId: 123, platform: "macos" });
  const failure = new Error("Mac resize constraints Core/AppKit owner changed during the native read");
  mocks.constraints.mockRejectedValue(failure);
  await expect(resizeWorkspaceWindow({ inspection: macInspection, edge: "bottomRight",
    requireRequestedFrame: "all", moves: [{ x: -295, y: -236 }], whileHeld: vi.fn() })).rejects.toBe(failure);
  expect(mocks.swift).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
});
