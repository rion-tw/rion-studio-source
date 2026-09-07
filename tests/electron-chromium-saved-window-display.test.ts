import { describe, expect, it } from "vitest";
import { resolveSavedWindowDisplay } from "../src/electron/main/chromiumSavedWindowDisplay";
import type { StateGameWindowRecord } from "../src/shared/generated";
import { dualDisplayTopology } from "./support/electronChromiumRuntimeLaunchFixtures";

describe.each(["macos", "windows"] as const)("%s legacy saved display compatibility", platform => {
  function fixture() {
    const topology = dualDisplayTopology();
    const display = topology.displays[0]!;
    display.isInternal = platform === "macos";
    // Electron screen.size is in DIP, unlike the retired shell's resolution.
    display.resolution = { width: display.bounds.width, height: display.bounds.height };
    const saved: StateGameWindowRecord = {
      id: "saved-window", name: "Saved", tabs: [],
      createdAt: topology.capturedAt, updatedAt: topology.capturedAt,
      targetDisplay: {
        id: 3220048483667338,
        fingerprint: {
          label: "Monitor #44602", bounds: { ...display.bounds },
          resolution: { width: 2880, height: 1800 }, scaleFactor: 2,
          isPrimary: true, isInternal: display.isInternal
        }
      },
      placement: {
        normalBounds: { x: 120, y: 90, width: 1080, height: 720 },
        savedWorkArea: { ...display.workArea }, presentation: "normal"
      }
    };
    return { saved, topology, display };
  }

  it("maps the legacy ID and physical resolution to the uniquely matching Electron display", () => {
    const { saved, topology, display } = fixture();
    expect(resolveSavedWindowDisplay(saved, topology)).toBe(display);
    expect(saved.targetDisplay.id).toBe(3220048483667338);
  });

  it("uses unique saved work-area evidence for pre-fingerprint records", () => {
    const { saved, topology, display } = fixture();
    delete saved.targetDisplay.fingerprint;
    expect(resolveSavedWindowDisplay(saved, topology)).toBe(display);
    topology.displays.push({ ...display, id: 123, isPrimary: false });
    expect(resolveSavedWindowDisplay(saved, topology)).toBeUndefined();
  });

  it("rejects changed legacy geometry and unavailable pre-fingerprint work areas", () => {
    const { saved, topology, display } = fixture();
    display.bounds = { ...display.bounds, x: -1440 };
    expect(resolveSavedWindowDisplay(saved, topology)).toBeUndefined();
    delete saved.targetDisplay.fingerprint;
    saved.placement.savedWorkArea.x = -999;
    expect(resolveSavedWindowDisplay(saved, topology)).toBeUndefined();
  });

  it("does not weaken a modern fingerprint or fall back to the primary display", () => {
    const { saved, topology, display } = fixture();
    saved.targetDisplay.fingerprint = {
      ...display, bounds: { ...display.bounds }, resolution: { ...display.resolution }
    };
    expect(resolveSavedWindowDisplay(saved, topology)).toBeUndefined();
    saved.targetDisplay.id = display.id;
    expect(resolveSavedWindowDisplay(saved, topology)).toBe(display);
    display.scaleFactor = 1;
    expect(resolveSavedWindowDisplay(saved, topology)).toBeUndefined();
  });
});
