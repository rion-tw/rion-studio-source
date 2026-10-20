import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installAppKitInitialPresentationProbe } from "../src/electron/e2e/appKitInitialPresentationObserver";
import { MacosAppKitChromiumRuntimeHostFactory } from "../src/electron/main/macosAppKitRuntimeHostFactory";
import { MacosAppKitRuntimePresentationController } from "../src/electron/main/macosAppKitRuntimePresentationController";
import { ChromiumRuntimeLaunchCoordinator } from "../src/electron/main/chromiumRuntimeLaunchCoordinator";
import { ElectronDisplayTopologyController } from "../src/electron/main/electronDisplayTopologyController";
import { FakeAddon, FakeBaseWindow, Fixture, target } from "./support/macosAppKitRuntimeHostFactoryFixtures";

const terminal = vi.hoisted(() => ({ handlers: [] as Array<() => void> }));
vi.mock("electron", () => ({ app: { once: (_event: string, handler: () => void) => terminal.handlers.push(handler) } }));
vi.mock("../src/electron/e2e/coreFlowDiagnosticsObserver", () => ({
  appendCoreFlowObservation: vi.fn(), describeCoreFlowError: (error: unknown) => String(error),
  nextCoreFlowIdentity: (name: string) => name
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originals = [
  [MacosAppKitChromiumRuntimeHostFactory, "fromElectronBaseWindow"],
  [MacosAppKitRuntimePresentationController.prototype, "setInitialPresentation"],
  [MacosAppKitRuntimePresentationController.prototype, "observeWindowPlacement"],
  [ChromiumRuntimeLaunchCoordinator.prototype, "openEmptySavedGameWindow"],
  [ElectronDisplayTopologyController.prototype, "refresh"]
] as const;
const descriptors = originals.map(([object, key]) => Object.getOwnPropertyDescriptor(object, key)!);
let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "rion-resize-carrier-"));
  vi.stubEnv("RION_STUDIO_E2E_PHASE", "chromium-tabs-visible-seed");
  vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", directory);
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  installAppKitInitialPresentationProbe();
});
afterAll(() => {
  originals.forEach(([object, key], index) => Object.defineProperty(object, key, descriptors[index]!));
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function largeNativeEvent() {
  return { type: "action", identity: { logicalWindowId: "window-1", launchGeneration: "launch-1", nativeGeneration: 1 },
    action: { type: "windowPlacementChanged", sourceWindowId: "window-1", placementDiagnostics: {
      zoomed: false, fullScreen: false, minimized: false,
      frameX: 32, frameY: 31, frameWidth: 935, frameHeight: 677,
      triggerEventType: 6, triggerKeyCode: 65535, triggerModifierFlags: 0,
      firstResponderCategory: "roleSurface", physicalInputSequence: "12",
      diagnosticResizeJournal: { journalVersion: 1, capacity: 128, sequence: 128, dropped: 0,
        records: Array.from({ length: 128 }, (_, index) => ({ sequence: index + 1,
          windowID: "window-1", windowPointer: "0x1234", reason: "notification:after",
          capturedAtUnixSeconds: 1792080000, diagnosticPadding: "x".repeat(1200) })) }
    } } };
}

async function admittedFactory(observed: boolean) {
  const fixture = new Fixture();
  const windows: FakeBaseWindow[] = [];
  class Constructor extends FakeBaseWindow {
    constructor() { super(8, fixture.order); windows.push(this); }
  }
  const addon = new FakeAddon(fixture.order);
  const observers = { displays: { displayMatching: () => fixture.display }, lifecycleEpoch: () => 1,
    onAction: fixture.onAction, onCloseRequested: fixture.onCloseRequested, onError: fixture.onError };
  const factory = observed ? MacosAppKitChromiumRuntimeHostFactory.fromElectronBaseWindow(
    addon, Constructor as never, observers
  ) : new MacosAppKitChromiumRuntimeHostFactory({ ...observers, addon,
    windows: { create: () => new Constructor() } });
  const host = await factory.createEmpty(target(), { attemptGeneration: "launch-1", windowGeneration: 1, topologyRevision: 1 });
  host.applyAppKitPhaseProjection!({ windowId: "window-1", windowGeneration: 1, topologyRevision: 1,
    tabIds: [], hiddenTabIds: [], tabPhases: [] });
  windows[0]!.visible = true;
  return { fixture, addon, host, native: windows[0]! };
}

async function proveThroughActualHost(event: ReturnType<typeof largeNativeEvent>) {
  const raw = JSON.stringify(event);
  expect(Buffer.byteLength(raw)).toBeGreaterThan(96 * 1024);
  const observed = await admittedFactory(true);
  observed.addon.callbacks[0]!(raw);
  expect(observed.fixture.onError).not.toHaveBeenCalled();
  expect(observed.fixture.onAction).toHaveBeenCalledTimes(1);
  const truth = { ...event.action.placementDiagnostics };
  delete (truth as Partial<typeof truth>).diagnosticResizeJournal;
  expect(observed.fixture.onAction.mock.calls[0]![0].action).toEqual({
    type: "windowPlacementChanged", sourceWindowId: "window-1", placementDiagnostics: truth
  });
  expect(observed.host.readProjection().presentation).toBe("normal");
  terminal.handlers[0]!();
  const artifact = JSON.parse(readFileSync(join(directory, "electron-appkit-native-resize-observations.json"), "utf8"));
  expect(artifact.captureErrors).toBe(0);
  expect(artifact.snapshots).toHaveLength(1);
  const snapshot = artifact.snapshots[0];
  expect(snapshot.journal).toEqual(event.action.placementDiagnostics.diagnosticResizeJournal);
  expect(snapshot).toMatchObject({ sourceWindowMatches: true, callbackIdentityMatches: true,
    currentNativeHandleMatches: true, currentWindowPointerMatches: true });
  const close = observed.host.close();
  await Promise.resolve();
  expect(observed.addon.controllers[0]!.destroyed).toBe(true);
  observed.addon.callbacks[0]!(raw);
  observed.native.emit("closed");
  await close;
  observed.addon.callbacks[0]!(raw);
  terminal.handlers[0]!();
  const retiredArtifact = JSON.parse(readFileSync(join(directory, "electron-appkit-native-resize-observations.json"), "utf8"));
  expect(retiredArtifact.snapshots[0]).toEqual(snapshot);
  expect(retiredArtifact.staleCallbacksIgnored).toBeGreaterThanOrEqual(2);
  expect(observed.fixture.onAction).toHaveBeenCalledTimes(1);
  expect(observed.fixture.onError).not.toHaveBeenCalled();

  const original = await admittedFactory(false);
  original.addon.callbacks[0]!(raw);
  expect(original.fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
    code: "ELECTRON_MACOS_APPKIT_EVENT_INVALID"
  }));
  expect(original.fixture.onAction).not.toHaveBeenCalled();
}

describe("diagnostic placement capture before the unchanged production host boundary", () => {
  it("retains the full ring while the actual production host receives only exact original truth", async () => {
    await proveThroughActualHost(largeNativeEvent());
  });
  const filename = resolve(".desktop-e2e-artifacts/native-resize-channel/rust-native-event.json");
  it.skipIf(!existsSync(filename))("passes the actual Rust C-argument parse/retain/emit output through observer and real host parser", async () => {
    await proveThroughActualHost(JSON.parse(readFileSync(filename, "utf8")));
  });
  it("does not hide an active identity mismatch as a retired callback", async () => {
    const observed = await admittedFactory(true);
    const event = largeNativeEvent();
    event.identity.nativeGeneration = 2;
    observed.addon.callbacks[0]!(JSON.stringify(event));
    expect(observed.fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_EVENT_STALE"
    }));
    expect(observed.fixture.onAction).not.toHaveBeenCalled();
    terminal.handlers[0]!();
    const artifact = JSON.parse(readFileSync(join(directory, "electron-appkit-native-resize-observations.json"), "utf8"));
    expect(artifact.snapshots[0].callbackIdentityMatches).toBe(false);
  });
});
