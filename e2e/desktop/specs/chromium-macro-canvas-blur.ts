import { browser, expect } from "@wdio/globals";
import type { Role } from "../../../src/shared/types";
import {
  electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eTrustedInputRuntime,
  type ElectronDesktopE2eTrustedInputObservation
} from "../support/electron-driver";
import { readVisibleElectronPageElementPoint } from "../support/electron-role-surface";
import { fixtureCursor, fixtureEvents, fixtureState, waitFixtureEvent } from "../support/fixture";
import { focusWindowsRoleCanvas } from "../support/windows-role-canvas";
import { focusWindowsRuntimeNativeWindow } from "../support/windows-runtime-foreground";
import { writeChromiumMacroEvidence } from "./chromium-macro-cutover-support";

/** The final action stays native; switching WebDriver targets would add a window blur. */
export async function exerciseWindowsHeldCanvasBlur(input: {
  role: Role; fixtureId: string; mainWindowHandle: string; windowId: string; processId: number;
  firstHold: ElectronDesktopE2eTrustedInputObservation;
  selector: "#tab-focus-input" | "#qa-target";
}): Promise<void> {
  const point = await readVisibleElectronPageElementPoint(
    input.role.launchUrl!, input.mainWindowHandle, input.selector
  );
  await focusWindowsRoleCanvas({ ...input, launchUrl: input.role.launchUrl!, roleId: input.role.id });
  const host = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
  const surface = host.surfaces.find(surface => surface.kind === "role" && surface.id === input.role.id && surface.visible);
  if (!host.nativeWindowHandle || !surface) throw new Error("The held Role has no exact visible native surface");
  const afterObservation = Math.max(0, ...(await electronDesktopE2eTrustedInputRuntime(input.role.id)).map(entry => entry.sequence));
  const afterSequence = await fixtureCursor();
  await focusWindowsRuntimeNativeWindow({
    processId: input.processId, nativeWindowHandle: host.nativeWindowHandle, pointerTarget: "content-click",
    contentPoint: {
      x: surface.bounds.x + point.x * surface.bounds.width / point.viewport.width,
      y: surface.bounds.y + point.y * surface.bounds.height / point.viewport.height
    }
  });
  const reset = await waitFixtureEvent({ afterSequence, kind: "consumer-input-reset", roleId: input.fixtureId });
  expect(reset.targetId).toBe("canvas-blur");
  const restored = await waitFixtureEvent({ afterSequence: reset.sequence, kind: "consumer-keydown", roleId: input.fixtureId });
  expect(restored).toMatchObject({ code: "Digit2", isTrusted: false,
    activeElementId: input.selector.slice(1), targetId: "game-input-canvas" });
  expect(restored.consumerPressedCodes).toContain("Digit2");
  let receipt: ElectronDesktopE2eTrustedInputObservation | undefined;
  await browser.waitUntil(async () => {
    receipt = (await electronDesktopE2eTrustedInputRuntime(input.role.id)).find(entry =>
      entry.sequence > afterObservation && entry.request.action.type === "reassertHeldKeys" &&
      entry.receipt.status === "applied");
    return receipt !== undefined;
  }, { timeout: 20_000, timeoutMsg: "Canvas focus loss did not obtain an exact Core continuity receipt" });
  expect(receipt!.request.inputEpoch).toBe(input.firstHold.request.inputEpoch);
  expect(receipt!.receipt.surfaceGeneration).toBe(input.firstHold.receipt.surfaceGeneration);
  const events = await fixtureEvents({ afterSequence, roleId: input.fixtureId });
  expect(events.filter(event => event.kind === "blur" || event.kind === "hidden")).toEqual([]);
  expect((await fixtureState())[input.fixtureId]!.consumerPressedCodes).toContain("Digit2");
  await writeChromiumMacroEvidence(`chromium-held-canvas-blur-${input.selector.slice(1)}.json`, { reset, restored, receipt, events });
}
