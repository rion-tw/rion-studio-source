import { describe, expect, it } from "vitest";
import type { StateGameWindowRecord } from "../src/shared/generated";
import { advanceWindowTopology, emptySavedWindow } from "./support/chromiumRuntimeLaunchFixtures";
import { launchHarness } from "./support/electronChromiumRuntimeLaunchHarness";
import { WINDOW_ID } from "./support/electronChromiumRuntimeLaunchFixtures";

describe("Electron Chromium empty saved-window placement admission", () => {
  const cases: Array<{
    name: string;
    initiallyAbsent?: boolean;
    change: (window: StateGameWindowRecord) => void;
  }> = [
    {
      name: "removal of the initial display fingerprint",
      change: window => { delete window.targetDisplay.fingerprint; }
    },
    {
      name: "a mismatched supplied display fingerprint",
      change: window => { window.targetDisplay.fingerprint!.label = "Unrelated display"; }
    },
    {
      name: "a malformed supplied display fingerprint",
      change: window => { window.targetDisplay.fingerprint!.resolution.width = 0; }
    },
    {
      name: "an unrelated monitor ID without a fingerprint",
      initiallyAbsent: true,
      change: window => { window.targetDisplay.id = 99; }
    },
    {
      name: "malformed fitted normal bounds without a fingerprint",
      initiallyAbsent: true,
      change: window => { window.placement.normalBounds.width = 639; }
    },
    {
      name: "fitted normal bounds outside the display work area",
      initiallyAbsent: true,
      change: window => { window.placement.normalBounds.x = -1; }
    },
    {
      name: "changed saved work-area evidence without a fingerprint",
      initiallyAbsent: true,
      change: window => { window.placement.savedWorkArea.y = 1; }
    },
    {
      name: "a newly supplied mismatched display fingerprint",
      initiallyAbsent: true,
      change: window => {
        window.targetDisplay.fingerprint = emptySavedWindow().targetDisplay.fingerprint;
        window.targetDisplay.fingerprint!.scaleFactor = 1;
      }
    }
  ];

  it.each(cases)("rejects $name after an exact native placement commit", async ({ initiallyAbsent, change }) => {
    const { coordinator, coreInvoke, launchCommands, state } = launchHarness({
      onRegister: (_command, harness) => {
        harness.coreSnapshot.state.gameWindows = harness.coreSnapshot.state.gameWindows.map(window => {
          const current = structuredClone(window);
          current.placement.normalBounds = { x: 120, y: 84, width: 1080, height: 700 };
          current.updatedAt = "2026-08-30T12:00:01.000Z";
          change(current);
          return current;
        });
        advanceWindowTopology(harness, 2, {
          bounds: { x: 120, y: 70, width: 1080, height: 692 }
        });
      }
    });
    const saved = emptySavedWindow();
    if (initiallyAbsent) delete saved.targetDisplay.fingerprint;
    state.coreSnapshot.state.gameWindows.push(saved);

    await expect(coordinator.openEmptySavedGameWindow(saved)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE"
    });
    expect(coreInvoke).toHaveBeenCalledWith(expect.objectContaining({
      type: "embeddedWindowRetireProvision",
      windowId: WINDOW_ID,
      windowGeneration: 1,
      topologyRevision: 3
    }));
    expect(state.coreSnapshot.logicalWindows).toEqual([]);
    expect(state.nativeSnapshot.windows).toEqual([]);
    expect(launchCommands).toHaveLength(0);
  });
});
