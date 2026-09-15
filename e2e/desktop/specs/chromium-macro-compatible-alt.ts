import { expect } from "@wdio/globals";
import { electronDesktopE2eProbe } from "../support/electron-driver";
import { readVisibleElectronCanvasPoint, submitElectronRoleKeyPhases } from "../support/electron-role-surface";
import { clickMacosVisibleRoleControl } from "../support/macos-appkit-ui";
import { pressVisibleMacosRoleKey, pressVisibleWindowsApplicationShortcut } from "../support/native-application-actions";
import { fixtureCursor, fixtureEvents, fixtureState, type FixtureEvent } from "../support/fixture";
import { rendererCall } from "../support/renderer-bridge";
import { rendererEventCursor, waitForMacroProjection } from "../support/renderer-events";

export async function exerciseCompatibleAltShortcuts(input: Readonly<{
  platform: "macos" | "windows"; roleId: string; roleName: string; fixtureRoleId: string;
  windowId: string; launchUrl: string; mainWindowHandle: string;
}>): Promise<void> {
  const macro = await rendererCall("createMacro", {
    activationMode: "press", enabled: true, name: "Chromium Compatible Alt Overlap",
    repeat: { type: "once" }, roleIds: [input.roleId],
    shortcutSourceScope: { type: "selected_roles", roleIds: [input.roleId] },
    trigger: { code: "Digit1", alt: true, ctrl: false, meta: false, shift: false },
    steps: [{ id: "alt-three", type: "key", code: "Digit3", action: "tap", modifiers: ["alt"] }]
  });
  const processId = (await electronDesktopE2eProbe()).processId;
  if (input.platform === "macos") {
    await clickMacosVisibleRoleControl(input.windowId, input.roleId,
      await readVisibleElectronCanvasPoint(input.launchUrl, input.mainWindowHandle));
  } else {
    await submitElectronRoleKeyPhases(input.launchUrl, input.mainWindowHandle, [], { windowId: input.windowId });
  }
  const key = async (action: "down" | "up" | "held-one" | "tap") => {
    if (input.platform === "macos") {
      const codes = { down: "AltDown", up: "AltUp", "held-one": "Alt+Digit1", tap: "Alt+Digit1Tap" } as const;
      await pressVisibleMacosRoleKey({ code: codes[action], processId,
        runtimeTabName: input.roleName, runtimeWindowId: input.windowId });
    } else {
      const commands = { down: "altDown", up: "altUp", "held-one": "altDigit1", tap: "altDigit1Tap" } as const;
      await pressVisibleWindowsApplicationShortcut({ command: commands[action], processId, targetMode: "focused-runtime" });
    }
  };
  const cycle = async (held: boolean) => {
    const afterSequence = await fixtureCursor();
    const projection = await rendererEventCursor();
    await key(held ? "held-one" : "tap");
    await waitForMacroProjection({ absent: true, afterSequence: projection, macroId: macro.id });
    let events: readonly FixtureEvent[] = [];
    await browser.waitUntil(async () => {
      events = (await Promise.all(["consumer-keydown", "consumer-keyup"].map(kind =>
        fixtureEvents({ afterSequence, roleId: input.fixtureRoleId, kind })))).flat()
        .sort((left, right) => left.sequence - right.sequence);
      return events.some(event => event.kind === "consumer-keyup" && event.code === "Digit3");
    }, { timeout: 20_000, timeoutMsg: "Alt+1 did not complete its compatible Alt+3 output" });
    for (const code of ["Digit1", "Digit3"]) {
      for (const kind of ["consumer-keydown", "consumer-keyup"]) {
        const phases = events.filter(event => event.kind === kind && event.code === code);
        expect(phases).toHaveLength(1);
        const phase = phases[0]!;
        expect(phase.modifiers?.alt).toBe(phase.consumerPressedCodes?.includes("AltLeft"));
        if (kind === "consumer-keydown" || code === "Digit3" || held) {
          expect(phase.modifiers?.alt).toBe(true);
        }
      }
    }
    if (held) {
      expect(events.filter(event => event.kind === "consumer-keyup" && event.code === "AltLeft")).toHaveLength(0);
      expect((await fixtureState())[input.fixtureRoleId]?.consumerPressedCodes).toEqual(["AltLeft"]);
    } else {
      await browser.waitUntil(async () =>
        (await fixtureState())[input.fixtureRoleId]?.consumerPressedCodes.length === 0,
      { timeout: 5000, timeoutMsg: "Quick Alt release left the consumer pressed" });
    }
  };
  try {
    await key("down");
    await cycle(true);
    await cycle(true);
  } finally { await key("up"); }
  const cycles = process.env.RION_STUDIO_E2E_PROFILE?.includes("hardware") ? 100 : 4;
  for (let index = 0; index < cycles; index++) await cycle(false);
}
