import { browser, expect } from "@wdio/globals";
import type { Role } from "../../../src/shared/types";
import { clickVisibleElectronCanvasWithPointer } from "../support/electron-role-surface";
import { fixtureCursor, fixtureEvents, fixtureState } from "../support/fixture";
import { withVisibleMacosRoleKeyReceipt, pressVisibleWindowsApplicationShortcut } from "../support/native-application-actions";
import { focusWindowsRoleCanvas } from "../support/windows-role-canvas";
import { writeChromiumMacroEvidence } from "./chromium-macro-cutover-support";

/** Physical same-key release cannot undo a Core-owned hold on its exact Canvas. */
export async function exerciseHeldKeyOverlap(input: {
  platform: "macos" | "windows"; role: Role; fixtureId: string;
  mainWindowHandle: string; windowId: string; processId: number;
}): Promise<void> {
  if (input.platform === "windows") await focusWindowsRoleCanvas({ ...input,
    roleId: input.role.id, launchUrl: input.role.launchUrl! });
  else await clickVisibleElectronCanvasWithPointer(input.role.launchUrl!, input.mainWindowHandle);
  const afterSequence = await fixtureCursor();
  const receive = async () => {
    // The later physical keyup proves that the earlier same-key release has
    // traversed Chromium. An elapsed wait would not establish this ordering.
    await browser.waitUntil(async () => (await fixtureEvents({ afterSequence, roleId: input.fixtureId }))
      .some(event => event.kind === "keyup" && event.code === "Digit3" && event.isTrusted),
    { timeout: 20_000, timeoutMsg: "The physical key sequence did not reach the held Role" });
    const events = await fixtureEvents({ afterSequence, roleId: input.fixtureId });
    expect(events.some(event => event.kind === "keydown" && event.code === "Digit2" && event.isTrusted)).toBe(true);
    expect(events.filter(event => event.kind === "consumer-keyup" && event.code === "Digit2")).toEqual([]);
    const state = (await fixtureState())[input.fixtureId]!;
    expect(state.consumerPressedCodes).toContain("Digit2");
    expect(state.consumerPressedCodes).not.toContain("Digit3");
    await writeChromiumMacroEvidence("chromium-held-key-overlap.json", { events, state });
  };
  if (input.platform === "macos") {
    const target = { processId: input.processId, runtimeWindowId: input.windowId, runtimeTabName: input.role.name };
    await withVisibleMacosRoleKeyReceipt({ ...target, code: "Digit2" }, signal =>
      withVisibleMacosRoleKeyReceipt({ ...target, code: "Digit3" }, receive, signal));
  } else {
    for (const code of ["Digit2", "Digit3"] as const) await pressVisibleWindowsApplicationShortcut({
      command: code === "Digit2" ? "digit2Tap" : "digit3Tap",
      processId: input.processId, targetMode: "focused-runtime" });
    await receive();
  }
}
