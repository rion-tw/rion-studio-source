import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ shortcut: vi.fn(), windows: vi.fn(), rawKey: vi.fn(), receipt: vi.fn(),
  waitEvent: vi.fn(), events: vi.fn(), state: vi.fn(), cursor: vi.fn(), write: vi.fn() }));
vi.mock("@wdio/globals", async () => ({ expect: (await import("vitest")).expect,
  browser: { waitUntil: async (condition: () => Promise<boolean>) => { expect(await condition()).toBe(true); } } }));
vi.mock("node:fs/promises", () => ({ writeFile: mocks.write }));
vi.mock("../e2e/desktop/support/electron-driver", () => ({
  electronDesktopE2eProbe: async () => ({ processId: 123 }),
  electronDesktopE2eFullscreenToolbarRuntime: async () => ({ nativeWindowHandle: "731", presentation,
    surfaces: tabIds.map(tabId => ({ tabId, visible: tabId === activeTab })) }),
  electronDesktopE2eApplicationShortcutRuntime: async () => ({
    coreWindow: { activeTabId: activeTab }, nativeWindow: { activeTabId: activeTab } })
}));
vi.mock("../e2e/desktop/support/electron-role-surface", () => ({
  clickVisibleElectronCanvasWithPointer: vi.fn(), clickVisibleElectronPageElementWithPointer: vi.fn()
}));
vi.mock("../e2e/desktop/support/windows-runtime-foreground", () => ({ focusWindowsRuntimeNativeWindow: vi.fn() }));
vi.mock("../e2e/desktop/support/fixture", () => ({
  fixtureCursor: mocks.cursor, fixtureEvents: mocks.events, fixtureState: mocks.state, waitFixtureEvent: mocks.waitEvent
}));
vi.mock("../e2e/desktop/support/native-application-actions", () => ({
  focusVisibleMacosAppKitRuntime: vi.fn(), pressVisibleMacosApplicationShortcut: mocks.shortcut,
  pressVisibleWindowsApplicationShortcut: mocks.windows, pressVisibleMacosRoleKey: mocks.rawKey,
  withVisibleMacosRoleKeyReceipt: mocks.receipt
}));

const tabIds = ["tab-alpha", "tab-beta"];
const roles = [{ name: "Alpha", launchUrl: "http://fixture/role/alpha" },
  { name: "Beta", launchUrl: "http://fixture/role/beta" }];
type Subject = { exerciseTabContentFocus(input: { platform: "macos" | "windows";
  windowId: string; mainWindowHandle: string; roles: typeof roles; tabIds: string[] }): Promise<void> };
type Event = { code: string; isTrusted: boolean; activeElementId: string; targetId: string;
  roleId: string; kind: string; modifiers: { alt: boolean; control: boolean; meta: boolean; shift: boolean } };
const target = (roleId: string) => roleId === "alpha" ? "tab-focus-input" : "game-input-canvas";
const neutral = () => ({ alpha: { pressedCodes: [], trustedPressedCodes: [] as string[] },
  beta: { pressedCodes: [], trustedPressedCodes: [] as string[] } });
const event = (roleId: string, code: string, kind: string): Event => ({ roleId, code, kind,
  isTrusted: true, activeElementId: target(roleId), targetId: target(roleId),
  modifiers: { alt: false, control: false, meta: false, shift: false } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
let subject: Subject;
let activeTab: string;
let presentation: "normal" | "fullscreen";
let lastKey: string;
let platform: "macos" | "windows";
let lastCursor: number;
const run = () => subject.exerciseTabContentFocus({ platform, windowId: "window", mainWindowHandle: "main", roles, tabIds });

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", process.cwd());
  activeTab = tabIds[1]!; presentation = "normal"; lastKey = "Escape"; platform = "macos"; lastCursor = 0;
  subject = await vi.importActual<Subject>("../e2e/desktop/specs/chromium-tab-content-focus");
  const shortcut = async ({ command }: { command: string }) => {
    if (command === "toggleFullscreen") presentation = presentation === "normal" ? "fullscreen" : "normal";
    if (command === "nextTab" || command === "previousTab") activeTab = activeTab === tabIds[0] ? tabIds[1]! : tabIds[0]!;
    if (command === "escape") lastKey = "Escape";
    if (command === "digit3Tap") lastKey = "Digit3";
  };
  mocks.shortcut.mockImplementation(shortcut); mocks.windows.mockImplementation(shortcut);
  mocks.rawKey.mockRejectedValue(new Error("unacknowledged raw Mac key sender was used"));
  mocks.cursor.mockImplementation(async () => ++lastCursor);
  mocks.waitEvent.mockImplementation(async ({ roleId, kind }: { roleId: string; kind: string }) => event(roleId, lastKey, kind));
  mocks.events.mockImplementation(async () => [event(activeTab === tabIds[0] ? "alpha" : "beta", "Escape", "keydown"),
    event(activeTab === tabIds[0] ? "alpha" : "beta", "Escape", "keyup")]);
  mocks.state.mockImplementation(async () => neutral());
  mocks.receipt.mockImplementation(async (_input, receive: (signal: AbortSignal) => Promise<unknown>) => {
    lastKey = "KeyY";
    return receive(new AbortController().signal);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("keeps all original KeyY receiver assertions before ACK and waits for the sender join before the next tab", async () => {
  const observed = deferred<void>(), state = deferred<ReturnType<typeof neutral>>();
  const acknowledged = deferred<void>(), closed = deferred<void>();
  const acknowledgements: string[] = [];
  mocks.state.mockImplementationOnce(() => { observed.resolve(); return state.promise; });
  mocks.receipt.mockImplementation(async (input: { runtimeTabName: string }, receive: (signal: AbortSignal) => Promise<unknown>) => {
    expect(lastCursor).toBeGreaterThan(0);
    lastKey = "KeyY";
    const value = await receive(new AbortController().signal);
    acknowledgements.push(input.runtimeTabName);
    if (input.runtimeTabName === "Alpha") { acknowledged.resolve(); await closed.promise; }
    return value;
  });
  const pending = run();
  await observed.promise;
  expect(mocks.waitEvent.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "keyup", roleId: "alpha" });
  expect(acknowledgements).toEqual([]);
  expect(mocks.receipt).toHaveBeenCalledOnce();
  expect(mocks.rawKey).not.toHaveBeenCalled();
  state.resolve(neutral());
  await acknowledged.promise;
  expect(acknowledgements).toEqual(["Alpha"]);
  expect(mocks.receipt).toHaveBeenCalledOnce();
  expect(mocks.write).not.toHaveBeenCalled();
  closed.resolve();
  await pending;
  expect(acknowledgements).toEqual(["Alpha", "Beta"]);
  expect(mocks.receipt.mock.calls.map(([input]) => input)).toEqual(roles.map(role => ({
    code: "KeyY", processId: 123, runtimeWindowId: "window", runtimeTabName: role.name
  })));
  expect(presentation).toBe("normal");
  expect(mocks.write).toHaveBeenCalledOnce();
});

it.each(["trust", "active target", "flags"])("does not acknowledge a failed KeyY %s assertion", async change => {
  const wait = mocks.waitEvent.getMockImplementation()!;
  mocks.waitEvent.mockImplementation(async (input: { roleId: string; kind: string }) => {
    const value = await wait(input) as Event;
    if (lastKey === "KeyY" && input.kind === "keydown") {
      if (change === "trust") value.isTrusted = false;
      if (change === "active target") value.activeElementId = "other-target";
      if (change === "flags") value.modifiers.control = true;
    }
    return value;
  });
  const acknowledged = vi.fn();
  mocks.receipt.mockImplementation(async (_input, receive: (signal: AbortSignal) => Promise<unknown>) => {
    lastKey = "KeyY";
    const value = await receive(new AbortController().signal);
    acknowledged(); return value;
  });
  await expect(run()).rejects.toThrow();
  expect(acknowledged).not.toHaveBeenCalled();
  expect(mocks.receipt).toHaveBeenCalledOnce();
  expect(mocks.write).not.toHaveBeenCalled();
});

it.each(["code", "trust", "active target", "flags"])("does not acknowledge a mismatched KeyY keyup %s", async change => {
  const wait = mocks.waitEvent.getMockImplementation()!;
  mocks.waitEvent.mockImplementation(async (input: { roleId: string; kind: string }) => {
    const value = await wait(input) as Event;
    if (lastKey === "KeyY" && input.kind === "keyup") {
      if (change === "code") value.code = "KeyX";
      if (change === "trust") value.isTrusted = false;
      if (change === "active target") value.activeElementId = "other-target";
      if (change === "flags") value.modifiers.shift = true;
    }
    return value;
  });
  const acknowledged = vi.fn();
  mocks.receipt.mockImplementation(async (_input, receive: (signal: AbortSignal) => Promise<unknown>) => {
    lastKey = "KeyY";
    const value = await receive(new AbortController().signal);
    acknowledged(); return value;
  });
  await expect(run()).rejects.toThrow();
  expect(acknowledged).not.toHaveBeenCalled();
  expect(mocks.receipt).toHaveBeenCalledOnce();
  expect(mocks.write).not.toHaveBeenCalled();
});

it.each(["keydown", "keyup"])("propagates receipt cancellation into the active KeyY %s wait without ACK or the next tab", async edge => {
  const original = new Error(`native receipt cancelled during ${edge}`);
  const controller = new AbortController();
  const wait = mocks.waitEvent.getMockImplementation()!;
  const receivedSignals: (AbortSignal | undefined)[] = [];
  mocks.waitEvent.mockImplementation(async (input: { roleId: string; kind: string; signal?: AbortSignal }) => {
    if (lastKey !== "KeyY") return wait(input);
    receivedSignals.push(input.signal);
    if (input.kind !== edge) return wait(input);
    if (!input.signal) throw new Error("receipt signal was not forwarded to the fixture wait");
    return new Promise((_resolve, reject) => {
      input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
      controller.abort(original);
    });
  });
  const acknowledged = vi.fn();
  mocks.receipt.mockImplementation(async (_input, receive: (signal: AbortSignal) => Promise<unknown>) => {
    lastKey = "KeyY";
    const value = await receive(controller.signal);
    acknowledged(); return value;
  });
  await expect(run()).rejects.toBe(original);
  expect(receivedSignals).toEqual(edge === "keydown" ? [controller.signal] : [controller.signal, controller.signal]);
  expect(acknowledged).not.toHaveBeenCalled();
  expect(mocks.receipt).toHaveBeenCalledOnce();
  expect(mocks.write).not.toHaveBeenCalled();
});

it("propagates the original missing KeyY up failure without acknowledging or submitting the next key", async () => {
  const original = new Error("exact KeyY up was not received");
  const wait = mocks.waitEvent.getMockImplementation()!;
  mocks.waitEvent.mockImplementation(async input => {
    if (lastKey === "KeyY" && input.kind === "keyup") throw original;
    return wait(input);
  });
  const acknowledged = vi.fn();
  mocks.receipt.mockImplementation(async (_input, receive: (signal: AbortSignal) => Promise<unknown>) => {
    lastKey = "KeyY";
    const value = await receive(new AbortController().signal);
    acknowledged(); return value;
  });
  await expect(run()).rejects.toBe(original);
  expect(acknowledged).not.toHaveBeenCalled();
  expect(mocks.receipt).toHaveBeenCalledOnce();
});

it("requires modifier neutrality in every Role before acknowledging KeyY", async () => {
  const held = neutral(); held.beta.trustedPressedCodes = ["ShiftLeft"];
  mocks.state.mockResolvedValue(held);
  const acknowledged = vi.fn();
  mocks.receipt.mockImplementation(async (_input, receive: (signal: AbortSignal) => Promise<unknown>) => {
    lastKey = "KeyY"; await receive(new AbortController().signal); acknowledged();
  });
  await expect(run()).rejects.toThrow();
  expect(acknowledged).not.toHaveBeenCalled();
  expect(mocks.receipt).toHaveBeenCalledOnce();
});

it("cancels the actual post-keyup state fetch before ACK or the next tab", async () => {
  const controller = new AbortController(), original = new Error("sender cancelled during state fetch");
  const request = deferred<AbortSignal | null | undefined>();
  const { fixtureState } = await vi.importActual<{
    fixtureState(signal?: AbortSignal): Promise<ReturnType<typeof neutral>>
  }>("../e2e/desktop/support/fixture");
  vi.stubEnv("RION_STUDIO_E2E_FIXTURE_ORIGIN", "http://fixture.test");
  const fetch = vi.fn((_url: string, options?: RequestInit) => {
    const pending = new Promise<Response>((_resolve, reject) => {
      if (!options?.signal) { reject(new Error("state request is not cancellable")); return; }
      options.signal.addEventListener("abort", () => reject(new DOMException("state aborted", "AbortError")), { once: true });
    });
    request.resolve(options?.signal);
    return pending;
  });
  vi.stubGlobal("fetch", fetch);
  mocks.state.mockImplementation(fixtureState);
  const acknowledged = vi.fn();
  mocks.receipt.mockImplementation(async (_input, receive: (signal: AbortSignal) => Promise<unknown>) => {
    lastKey = "KeyY";
    const value = await receive(controller.signal);
    acknowledged(); return value;
  });
  const outcome = run().catch(error => error);
  const active = await request.promise;
  controller.abort(original);
  expect(await outcome).toBe(original);
  expect(active).toBe(controller.signal);
  expect(fetch).toHaveBeenCalledOnce();
  expect(mocks.waitEvent.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "keyup", roleId: "alpha" });
  expect(acknowledged).not.toHaveBeenCalled();
  expect(mocks.receipt).toHaveBeenCalledOnce();
  expect(mocks.write).not.toHaveBeenCalled();
});

it("keeps Windows on its original Digit3 sender and strict receiver path", async () => {
  platform = "windows";
  await run();
  expect(mocks.receipt).not.toHaveBeenCalled();
  expect(mocks.rawKey).not.toHaveBeenCalled();
  expect(mocks.windows.mock.calls.filter(([input]) => input.command === "digit3Tap").map(([input]) => input))
    .toEqual([1, 2].map(() => ({ command: "digit3Tap", processId: 123,
      nativeWindowHandle: "731", targetMode: "focused-runtime" })));
  expect(mocks.waitEvent.mock.calls.filter(([input]) => input.kind === "keydown")).toHaveLength(2);
  expect(mocks.waitEvent.mock.calls.every(([input]) => !Object.hasOwn(input, "signal"))).toBe(true);
  expect(mocks.state.mock.calls.every(args => args.length === 0)).toBe(true);
  expect(mocks.write).toHaveBeenCalledOnce();
});
