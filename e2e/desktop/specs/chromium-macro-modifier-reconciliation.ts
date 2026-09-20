import { browser, expect } from "@wdio/globals";
import { electronDesktopE2eProbe } from "../support/electron-driver";
import { fixtureCursor, fixtureEvents, fixtureState } from "../support/fixture";
import { rendererCall } from "../support/renderer-bridge";
import { modifierReleaseFault } from "../support/modifier-release-fault";
import { pressVisibleMacosRoleKey, pressVisibleWindowsApplicationShortcut } from "../support/native-application-actions";

export async function exerciseModifierReconciliation(input: Readonly<{
  platform: "macos" | "windows"; roleId: string; roleName: string; fixtureRoleId: string;
  windowId: string; launchUrl: string;
}>): Promise<void> {
  const processId = (await electronDesktopE2eProbe()).processId;
  const key = async (action: "down" | "up" | "trigger") => {
    if (input.platform === "macos") {
      const codes = { down: "AltDown", up: "AltUp", trigger: "Shift+Digit3" } as const;
      await pressVisibleMacosRoleKey({ code: codes[action], processId,
        runtimeTabName: input.roleName, runtimeWindowId: input.windowId });
    } else {
      const commands = { down: "altDown", up: "altUp", trigger: "shiftDigit3" } as const;
      await pressVisibleWindowsApplicationShortcut({ command: commands[action], processId, targetMode: "focused-runtime" });
    }
  };
  const afterSequence = await fixtureCursor();
  try {
    await key("down");
    await browser.waitUntil(async () => (await fixtureEvents({ afterSequence,
      roleId: input.fixtureRoleId, kind: "consumer-keydown" })).some(event => event.code === "AltLeft"),
    { timeout: 5000, timeoutMsg: "The physical Alt-down did not reach the consumer" });
    await modifierReleaseFault(input.launchUrl, "arm");
    await key("up");
    await browser.waitUntil(() => modifierReleaseFault(input.launchUrl, "read"), {
      timeout: 5000, timeoutMsg: "The classified missing-Alt-keyup precondition was not reached"
    });
    // The player starts the existing Shift+3 macro through real visible input.
    // Its Shift-down proves Alt is released before managed shortcut admission.
    await key("trigger");
    await browser.waitUntil(async () => (await fixtureEvents({ afterSequence,
      roleId: input.fixtureRoleId, kind: "consumer-keyup" })).some(event => event.code === "Digit1"),
    { timeout: 20_000, timeoutMsg: "The visible shortcut did not finish compatible Digit1 output" });
    const events = (await Promise.all(["consumer-keydown", "consumer-keyup"].map(kind =>
      fixtureEvents({ afterSequence, roleId: input.fixtureRoleId, kind })))).flat()
      .sort((a, b) => a.sequence - b.sequence);
    const releases = events.filter(event => event.kind === "consumer-keyup" && event.code === "AltLeft");
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ isTrusted: false, keyCode: 18, which: 18, modifiers: { alt: false } });
    for (const code of ["Digit3", "Digit1"]) for (const kind of ["consumer-keydown", "consumer-keyup"]) {
      const phases = events.filter(event => event.code === code && event.kind === kind);
      expect(phases).toHaveLength(1);
      expect(phases[0]!.sequence).toBeGreaterThan(releases[0]!.sequence);
      expect(phases[0]!.modifiers?.alt).toBe(false);
      expect(phases[0]!.consumerPressedCodes).not.toContain("AltLeft");
    }
    await browser.waitUntil(async () => {
      const { entries } = await rendererCall("queryLogs", { levels: ["debug"], limit: 100, search: "trusted_input_terminal" });
      return entries.some(entry => {
        if (entry.context?.roleId !== input.roleId || entry.context?.code !== "Digit1") return false;
        const evidence = entry.context?.compatibleModifierEvidence as {
          transitions?: Array<{ source: string; code: string; disposition: string }>;
        } | undefined;
        return evidence?.transitions?.some(transition => transition.source === "physical-reconcile" &&
          transition.code === "AltLeft" && transition.disposition === "dispatch") === true;
      });
    }, { timeout: 10_000, timeoutMsg: "The release was not attributed to physical event reconciliation" });
    await browser.waitUntil(async () => (await fixtureState())[input.fixtureRoleId]?.consumerPressedCodes.length === 0,
      { timeout: 5000, timeoutMsg: "Modifier reconciliation left a consumer key held" });
  } finally {
    await modifierReleaseFault(input.launchUrl, "clear");
    await key("up");
  }
}
