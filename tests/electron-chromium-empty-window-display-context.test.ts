import { describe, expect, it } from "vitest";
import type { CoreCommand } from "../src/shared/generated";
import { emptySavedWindow } from "./support/chromiumRuntimeLaunchFixtures";
import { launchHarness } from "./support/electronChromiumRuntimeLaunchHarness";

const currentDisplay = {
  id: 41,
  fingerprint: {
    label: "Built-in Display",
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    resolution: { width: 2880, height: 1800 },
    scaleFactor: 2,
    isPrimary: true,
    isInternal: true
  }
};
type Register = Extract<CoreCommand, { type: "embeddedWindowRegister" }>;

describe("empty-window current display context admission", () => {
  it.each(["current", "legacy", "absent", "changed-modern"] as const)(
    "supplies the current canonical fingerprint instead of %s saved metadata", async metadata => {
      const { coordinator, coreInvoke, state } = launchHarness();
      const saved = emptySavedWindow();
      if (metadata === "legacy") {
        saved.targetDisplay.id = 3220048483667338;
        saved.targetDisplay.fingerprint!.label = "Monitor #44602";
      } else if (metadata === "absent") delete saved.targetDisplay.fingerprint;
      else if (metadata === "changed-modern") saved.targetDisplay.fingerprint!.label = "Retired Display";
      state.coreSnapshot.state.gameWindows.push(saved);

      await coordinator.openEmptySavedGameWindow(saved);

      expect(coreInvoke).toHaveBeenCalledWith(expect.objectContaining({
        type: "embeddedWindowRegister", targetDisplay: currentDisplay
      }));
      expect(saved.targetDisplay.fingerprint?.label).toBe(metadata === "legacy" ? "Monitor #44602"
        : metadata === "absent" ? undefined : metadata === "changed-modern" ? "Retired Display" : "Built-in Display");
    }
  );

  it("supplies the full display on fullscreen reopen without a native placement callback", async () => {
    const registrations: Register[] = [];
    const { coordinator, state } = launchHarness({
      onRegister: command => { registrations.push(structuredClone(command)); }
    });
    const saved = emptySavedWindow();
    saved.placement.presentation = "fullscreen";
    state.coreSnapshot.state.gameWindows.push(saved);
    await coordinator.openEmptySavedGameWindow(saved);
    state.coreSnapshot.logicalWindows = [];
    state.coreSnapshot.browserRuntime.windows = [];
    state.nativeSnapshot = { windows: [], tabs: [], roles: [], webSurfaces: [] };

    await coordinator.openEmptySavedGameWindow(saved);

    expect(registrations).toHaveLength(2);
    for (const registration of registrations) {
      expect(registration.targetDisplay).toEqual(currentDisplay);
      expect(registration.target.presentation).toBe("fullscreen");
    }
  });

  it("copies inventory bounds and resolution before the Core command crosses its async boundary", async () => {
    const { coordinator, coreInvoke, state } = launchHarness();
    const saved = emptySavedWindow();
    state.coreSnapshot.state.gameWindows.push(saved);
    await coordinator.openEmptySavedGameWindow(saved);
    const registration = coreInvoke.mock.calls.map(([command]) => command)
      .find((command): command is Register => command.type === "embeddedWindowRegister")!;
    expect(Object.isFrozen(registration.targetDisplay)).toBe(true);
    expect(Object.isFrozen(registration.targetDisplay.fingerprint)).toBe(true);
    expect(Object.isFrozen(registration.targetDisplay.fingerprint!.bounds)).toBe(true);
    expect(Object.isFrozen(registration.targetDisplay.fingerprint!.resolution)).toBe(true);
    const display = state.topology.displays[0]!;
    display.bounds.x = 900;
    display.resolution.width = 3840;
    display.label = "Later Inventory";
    saved.targetDisplay.fingerprint!.bounds.y = 500;

    expect(registration.targetDisplay).toEqual(currentDisplay);
  });
});
