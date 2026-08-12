import { expect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  controlWindow,
  probe,
  rendererCall,
  requireEnvironment,
  shutdown,
  waitEvent,
  windowSnapshot,
  type DesktopE2eWindowSnapshot
} from "../support/control";
import { expectBoundsNear } from "../support/geometry";
import { waitForTranscriptEvent } from "../support/transcript";

// [journey:NATIVE-DISPLAY-001]

const WINDOW_A = "e2e00000-0000-4000-8000-00000000000a";

async function transition(
  snapshot: DesktopE2eWindowSnapshot,
  presentation: "fullscreen" | "maximized" | "normal"
): Promise<DesktopE2eWindowSnapshot> {
  const cursor = (await probe()).latestSequence;
  await controlWindow(WINDOW_A, { action: "setPresentation", presentation });
  await waitEvent({
    afterSequence: cursor,
    kind: "placement-accepted",
    minimumGeneration: snapshot.windowGeneration,
    presentation,
    timeoutMs: 60_000,
    windowId: WINDOW_A
  });
  return windowSnapshot(WINDOW_A);
}

async function cleanExit(): Promise<void> {
  const control = await probe();
  const requestedAfter = new Date().toISOString();
  await shutdown().catch(() => undefined);
  const event = await waitForTranscriptEvent(
    control.transcriptPath,
    (candidate) => candidate.kind === "application-final-flush-complete"
      && candidate.timestamp >= requestedAfter
  );
  expect((event.details as { complete?: boolean }).complete).toBe(true);
}

describe("extended native Game Window placement", () => {
  it("crosses real displays and preserves logical placement without drift", async () => {
    const topology = await rendererCall("getDisplayTopology");
    if (topology.displays.length < 2) {
      throw new Error("BLOCKED: extended desktop E2E requires two real displays");
    }
    if (process.platform === "win32"
      && new Set(topology.displays.map((display) => display.scaleFactor)).size < 2) {
      throw new Error("BLOCKED: Windows extended desktop E2E requires mixed DPI displays");
    }
    if (process.platform === "darwin"
      && new Set(topology.displays.map((display) => display.scaleFactor)).size < 2) {
      throw new Error("BLOCKED: macOS extended desktop E2E requires displays with different scale factors");
    }
    const target = topology.displays.find((display) => !display.isPrimary
      && (process.platform !== "win32" || display.workArea.x < 0 || display.workArea.y < 0));
    if (!target) {
      throw new Error(process.platform === "win32"
        ? "BLOCKED: Windows extended desktop E2E requires a negative-coordinate secondary display"
        : "BLOCKED: macOS extended desktop E2E requires a secondary display");
    }
    if (target.bounds.x === target.workArea.x
      && target.bounds.y === target.workArea.y
      && target.bounds.width === target.workArea.width
      && target.bounds.height === target.workArea.height) {
      throw new Error("BLOCKED: extended desktop E2E requires a display with a non-empty taskbar or Dock work-area inset");
    }
    const width = Math.max(640, Math.min(900, target.workArea.width - 120));
    const height = Math.max(480, Math.min(640, target.workArea.height - 140));
    const bounds = {
      height,
      width,
      x: target.workArea.x + 45,
      y: target.workArea.y + 55
    };
    let snapshot = await windowSnapshot(WINDOW_A).catch(() => undefined);
    if (!snapshot) {
      const showCursor = (await probe()).latestSequence;
      await rendererCall("showGameWindow", WINDOW_A);
      await waitEvent({
        afterSequence: showCursor,
        kind: "window-context-initialized",
        timeoutMs: 60_000,
        windowId: WINDOW_A
      });
      snapshot = await windowSnapshot(WINDOW_A);
    }
    const cursor = (await probe()).latestSequence;
    await controlWindow(WINDOW_A, {
      action: "moveResize",
      scaleFactor: target.scaleFactor,
      ...bounds
    });
    await waitEvent({
      afterSequence: cursor,
      kind: "placement-accepted",
      minimumGeneration: snapshot.windowGeneration,
      timeoutMs: 60_000,
      windowId: WINDOW_A
    });
    snapshot = await windowSnapshot(WINDOW_A);
    if (process.platform === "win32") {
      const dpiEvent = await waitEvent({
        afterSequence: cursor,
        kind: "windows-wm-dpi-changed",
        timeoutMs: 60_000
      });
      const details = dpiEvent.details as { dpi?: number; handle?: string };
      expect(details.dpi).toBe(Math.round(target.scaleFactor * 96));
      expect(details.handle).toBe(snapshot.native.handle);
    }
    expect(snapshot.kernel?.targetDisplay?.id).toBe(target.id);
    expectBoundsNear(snapshot.kernel?.placement?.normalBounds ?? bounds, bounds);
    expectBoundsNear(snapshot.target.bounds, bounds);

    snapshot = await transition(snapshot, "maximized");
    expect(snapshot.native.presentation).toBe("maximized");
    expectBoundsNear(snapshot.kernel?.placement?.normalBounds ?? bounds, bounds);
    snapshot = await transition(snapshot, "normal");
    expectBoundsNear(snapshot.kernel?.placement?.normalBounds ?? bounds, bounds);
    snapshot = await transition(snapshot, "fullscreen");
    expect(snapshot.native.presentation).toBe("fullscreen");
    expectBoundsNear(snapshot.kernel?.placement?.normalBounds ?? bounds, bounds);
    snapshot = await transition(snapshot, "normal");
    expectBoundsNear(snapshot.kernel?.placement?.normalBounds ?? bounds, bounds);
    await writeFile(
      resolve(requireEnvironment("RION_STUDIO_E2E_ARTIFACT_DIR"), "native-environment.json"),
      `${JSON.stringify({ finalSnapshot: snapshot, target, topology }, null, 2)}\n`
    );
    await cleanExit();
  });
});
