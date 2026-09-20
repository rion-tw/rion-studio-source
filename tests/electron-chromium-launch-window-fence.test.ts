import { describe, expect, it, vi } from "vitest";
import { runtimeOperationEvidence } from "../src/electron/main/runtimeOperationJournal";
import { launchHarness } from "./support/electronChromiumRuntimeLaunchHarness";
import { ROLE_ID, WINDOW_ID, WORKSPACE_ID, topology } from "./support/electronChromiumRuntimeLaunchFixtures";

const destination = { kind: "game-window" as const, windowId: WINDOW_ID };

describe.each(["darwin", "win32"])("%s current window launch admission", platform => {
  it("reuses an exact host repeatedly after late projection and a changed presentation discarded its cache", async () => {
    const h = launchHarness({ observedSnapshots: true, onLaunch: (command, state) => {
      if (command.type === "browserRoleLaunch") state.nativeSnapshot = { ...state.nativeSnapshot,
        windows: state.nativeSnapshot.windows.map(window => ({ ...window, topologyRevision: 0 })) };
    } });
    h.state.topology = topology(1, { x: 0, y: platform === "darwin" ? 24 : 0, width: 1440, height: 860 });
    await h.coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    h.state.nativeSnapshot = { ...h.state.nativeSnapshot,
      windows: h.state.nativeSnapshot.windows.map(window => ({ ...window,
        topologyRevision: h.state.coreSnapshot.logicalWindows[0]!.revision, presentation: "maximized" })) };
    for (let i = 0; i < 2; i++) await expect(h.coordinator.launchWorkspace(WORKSPACE_ID, destination))
      .resolves.toMatchObject({ windowId: WINDOW_ID });
    expect(h.launchCommands).toHaveLength(3);
  });

  it("rejects a same-count foreign tab and records the precise identity mismatch", async () => {
    const h = launchHarness({ observedSnapshots: true });
    await h.coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    h.state.nativeSnapshot = { ...h.state.nativeSnapshot,
      tabs: h.state.nativeSnapshot.tabs.map(tab => ({ ...tab, tabId: "foreign-tab" })) };
    await expect(h.coordinator.launchWorkspace(WORKSPACE_ID, destination)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE"
    });
    expect(runtimeOperationEvidence().entries.filter(entry => entry.action === "launch-window-fence").at(-1))
      .toMatchObject({ stage: "rejected", targetId: WINDOW_ID, fences: {
        reason: "tab-identities", liveNativeTabIds: "foreign-tab", waitedNativeEvents: 0, waitedProjection: 0
      } });
    expect(h.launchCommands).toHaveLength(1);
  });
});

it("consumes received target events before their projection exists, then reads fresh Core/native state", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let eventPending = false, effectPending = false;
  const events = vi.fn(async (id: string) => {
    expect(id).toBe(WINDOW_ID);
    if (!eventPending) return false;
    entered(); await gate;
    eventPending = false; effectPending = true;
    return true;
  });
  const projection = vi.fn(async () => {
    if (!effectPending) return false;
    effectPending = false;
    h.state.nativeSnapshot = { ...h.state.nativeSnapshot, windows: h.state.nativeSnapshot.windows.map(window =>
      ({ ...window, topologyRevision: h.state.coreSnapshot.logicalWindows[0]!.revision })) };
    return true;
  });
  const h = launchHarness({ observedSnapshots: true, settleWindowNativeEvents: events, settleWindowProjection: projection });
  await h.coordinator.launchRole(ROLE_ID, { kind: "new-window" });
  h.state.coreSnapshot.logicalWindows[0]!.revision++;
  eventPending = true;
  const launch = h.coordinator.launchWorkspace(WORKSPACE_ID, destination);
  await waiting;
  expect(projection).not.toHaveBeenCalled();
  expect(h.launchCommands).toHaveLength(1);
  release();
  await expect(launch).resolves.toMatchObject({ windowId: WINDOW_ID });
  expect(h.launchCommands).toHaveLength(2);
});

it("admits a host created outside this launch coordinator using current authoritative identities", async () => {
  const h = launchHarness({ observedSnapshots: true });
  await h.coreInvoke({ type: "browserRoleLaunch", roleId: ROLE_ID, target: {
    windowId: WINDOW_ID, displayId: 41, scaleFactor: 2, presentation: "normal",
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
    bounds: { x: 100, y: 50, width: 900, height: 600 }
  } });
  await expect(h.coordinator.launchWorkspace(WORKSPACE_ID, destination)).resolves.toMatchObject({ windowId: WINDOW_ID });
  expect(h.launchCommands).toHaveLength(2);
});
