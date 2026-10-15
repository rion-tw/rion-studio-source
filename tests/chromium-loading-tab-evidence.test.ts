import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), resize: vi.fn(), waitUntil: vi.fn() }));
vi.mock("@wdio/globals", async () => ({
  expect: (await import("vitest")).expect,
  browser: { waitUntil: mocks.waitUntil }
}));
vi.mock("../e2e/desktop/support/electron-driver", () => ({
  electronDesktopE2eFullscreenToolbarRuntime: mocks.inspect,
  electronDesktopE2eApplicationShortcutRuntime: vi.fn(),
  electronDesktopE2eGameWindowRuntime: vi.fn()
}));
vi.mock("../e2e/desktop/support/workspace-window-resize", () => ({ resizeWorkspaceWindow: mocks.resize }));
vi.mock("../e2e/desktop/support/workspace-pixels", () => ({ captureWorkspacePixels: vi.fn() }));

type Bounds = { x: number; y: number; width: number; height: number };
type Inspection = {
  hostKind: "appkit" | "windows"; windowId: string; windowGeneration: number;
  topologyRevision: number; nativeWindowHandle?: string; tabIds: string[];
  surfaces: { id: string; kind: "role" | "web"; tabId: string; generation: number;
    bounds: Bounds; visible: boolean }[];
};
type ResizeInput = {
  inspection: Inspection; edge: "right" | "bottom" | "bottomRight";
  moves: { x: number; y: number }[]; whileHeld: () => Promise<void>;
};
type Subject = {
  resizeReadyTabWhileSiblingLoads(input: {
    platform: "macos" | "windows"; windowId: string; tabId: string;
  }): Promise<Bounds>;
};

const initial = (platform: "macos" | "windows" = "macos"): Inspection => ({
  hostKind: platform === "macos" ? "appkit" : "windows", windowId: "window",
  windowGeneration: 227, topologyRevision: 242,
  ...(platform === "windows" ? { nativeWindowHandle: "731" } : {}),
  tabIds: ["ready", "loading"],
  surfaces: [
    { id: "surface-a", kind: "role", tabId: "ready", generation: 3,
      bounds: { x: 56, y: 71, width: 960, height: 637 }, visible: true },
    { id: "surface-b", kind: "role", tabId: "loading", generation: 4,
      bounds: { x: 56, y: 71, width: 960, height: 637 }, visible: false }
  ]
});

let live: Inspection;
let subject: Subject;
beforeEach(async () => {
  vi.resetAllMocks();
  live = initial();
  // This subject is part of the separate WDIO compilation graph.
  subject = await vi.importActual<Subject>("../e2e/desktop/specs/chromium-loading-tab-evidence");
  mocks.inspect.mockImplementation(async () => structuredClone(live));
  mocks.waitUntil.mockImplementation(async (condition: () => Promise<boolean>) => {
    expect(await condition()).toBe(true);
  });
  mocks.resize.mockImplementation(async (input: ResizeInput) => {
    // Model the unchanged native constraint fence and the first drag's real
    // WindowState commit: a later drag cannot reuse its predecessor's revision.
    if (input.inspection.topologyRevision !== live.topologyRevision) {
      throw new Error("Mac resize constraints require the exact visible Core/AppKit owner");
    }
    const move = input.moves[0]!;
    live.topologyRevision += 1;
    for (const surface of live.surfaces) {
      surface.bounds.width += move.x;
      surface.bounds.height += move.y;
    }
    await input.whileHeld();
  });
});

it("uses the first drag's completed revision for the next Mac border while retaining the original two-axis baseline", async () => {
  const result = await subject.resizeReadyTabWhileSiblingLoads({
    platform: "macos", windowId: "window", tabId: "ready"
  });
  const inputs = mocks.resize.mock.calls.map(([input]) => input as ResizeInput);
  expect(inputs.map(input => input.edge)).toEqual(["right", "bottom"]);
  expect(inputs.map(input => input.inspection.topologyRevision)).toEqual([242, 243]);
  expect(inputs.map(input => input.inspection.surfaces[0]!.bounds)).toEqual([
    { x: 56, y: 71, width: 960, height: 637 }, { x: 56, y: 71, width: 864, height: 637 }
  ]);
  expect(result).toEqual({ x: 56, y: 71, width: 864, height: 541 });
  expect(mocks.waitUntil).toHaveBeenCalledTimes(2);
});

it("preserves the single Windows bottom-right drag and both original size assertions", async () => {
  live = initial("windows");
  expect(await subject.resizeReadyTabWhileSiblingLoads({
    platform: "windows", windowId: "window", tabId: "ready"
  })).toEqual({ x: 56, y: 71, width: 912, height: 605 });
  expect(mocks.resize).toHaveBeenCalledOnce();
  expect(mocks.resize.mock.calls[0]![0]).toMatchObject({
    edge: "bottomRight", inspection: { nativeWindowHandle: "731", topologyRevision: 242 },
    moves: [{ edge: "bottomRight", x: -48, y: -32 }]
  });
});

const changedOwners: [string, (inspection: Inspection) => void][] = [
  ["window ID", inspection => { inspection.windowId = "replacement"; }],
  ["window generation", inspection => { inspection.windowGeneration += 1; }],
  ["host kind", inspection => { inspection.hostKind = "windows"; }],
  ["native handle", inspection => { inspection.nativeWindowHandle = "replacement"; }],
  ["tab order", inspection => { inspection.tabIds.reverse(); }],
  ["tab cohort", inspection => { inspection.tabIds.pop(); }],
  ["surface ID", inspection => { inspection.surfaces[0]!.id = "replacement"; }],
  ["surface kind", inspection => { inspection.surfaces[0]!.kind = "web"; }],
  ["surface tab", inspection => { inspection.surfaces[0]!.tabId = "loading"; }],
  ["surface generation", inspection => { inspection.surfaces[0]!.generation += 1; }],
  ["surface cohort", inspection => { inspection.surfaces.pop(); }]
];

it.each(changedOwners)("rejects a fresh %s replacement before submitting any pointer input", async (_name, change) => {
  const replacement = structuredClone(live);
  change(replacement);
  mocks.inspect.mockResolvedValueOnce(structuredClone(live)).mockResolvedValueOnce(replacement);
  await expect(subject.resizeReadyTabWhileSiblingLoads({
    platform: "macos", windowId: "window", tabId: "ready"
  })).rejects.toThrow("Native resize lost the original window, tab, or surface owner");
  expect(mocks.resize).not.toHaveBeenCalled();
});

it("rejects an owner replaced after the first drag before the next border is pressed", async () => {
  const resize = mocks.resize.getMockImplementation()!;
  mocks.resize.mockImplementation(async (input: ResizeInput) => {
    await resize(input);
    live.windowGeneration += 1;
  });
  await expect(subject.resizeReadyTabWhileSiblingLoads({
    platform: "macos", windowId: "window", tabId: "ready"
  })).rejects.toThrow("Native resize lost the original window, tab, or surface owner");
  expect(mocks.resize).toHaveBeenCalledOnce();
});

it("retains a fresh-read failure and does not start the following native drag", async () => {
  const failure = new Error("the exact native inspection was unavailable");
  mocks.inspect.mockImplementationOnce(async () => structuredClone(live))
    .mockImplementationOnce(async () => structuredClone(live))
    .mockImplementationOnce(async () => structuredClone(live))
    .mockRejectedValueOnce(failure);
  await expect(subject.resizeReadyTabWhileSiblingLoads({
    platform: "macos", windowId: "window", tabId: "ready"
  })).rejects.toBe(failure);
  expect(mocks.resize).toHaveBeenCalledOnce();
});

it("starts no second drag until the first native drag has reached its terminal outcome", async () => {
  let finish!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const firstTerminal = new Promise<void>(resolve => { finish = resolve; });
  const resize = mocks.resize.getMockImplementation()!;
  mocks.resize.mockImplementation(async (input: ResizeInput) => {
    await resize(input);
    if (input.edge === "right") { started(); await firstTerminal; }
  });
  const task = subject.resizeReadyTabWhileSiblingLoads({
    platform: "macos", windowId: "window", tabId: "ready"
  });
  await firstStarted;
  expect(mocks.resize).toHaveBeenCalledOnce();
  finish();
  await expect(task).resolves.toEqual({ x: 56, y: 71, width: 864, height: 541 });
  expect(mocks.resize).toHaveBeenCalledTimes(2);
});
