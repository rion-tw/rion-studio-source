import { expect } from "@wdio/globals";
import {
  electronDesktopE2eGameWindowRuntime, electronDesktopE2eTrustedInputRuntime
} from "../support/electron-driver";
import { fixtureCursor, fixtureEvents, waitFixtureEvent } from "../support/fixture";
import { withVisibleMacosRoleKeyReceipt } from "../support/native-application-actions";
import { submitElectronRoleKeyPhases } from "../support/electron-role-surface";

export async function verifyUnboundChromiumInput(input: Readonly<{
  mainWindowHandle: string; platform: "macos" | "windows"; processId: number;
  roleId: string; roleName: string; roleUrl: string; fixtureId: string; windowId: string;
}>): Promise<void> {
  const before = (await electronDesktopE2eGameWindowRuntime(input.windowId)).currentRuntime;
  expect(before).not.toBeNull();
  const submissions = await electronDesktopE2eTrustedInputRuntime(input.roleId);
  const cursor = await fixtureCursor();
  const receiveKeyY = async (signal?: AbortSignal): Promise<void> => {
    let afterSequence = cursor;
    for (;;) {
      const event = await waitFixtureEvent({ afterSequence, kind: "keyup", roleId: input.fixtureId,
        ...(signal ? { signal } : {}) });
      if (event.code === "KeyY" && event.isTrusted) return;
      afterSequence = event.sequence;
    }
  };
  if (input.platform === "macos") {
    // Keep the native sender alive until the page receipt; an early exit can
    // drop the key before Chromium consumes it on a busy runner.
    await withVisibleMacosRoleKeyReceipt({ code: "KeyY", processId: input.processId,
      runtimeTabName: input.roleName, runtimeWindowId: input.windowId }, receiveKeyY);
  } else {
    await submitElectronRoleKeyPhases(input.roleUrl, input.mainWindowHandle, [
      { key: "y", phase: "keyDown" }, { key: "y", phase: "keyUp" }
    ], { windowId: input.windowId });
    await receiveKeyY();
  }
  const keys = (await fixtureEvents({ afterSequence: cursor, roleId: input.fixtureId }))
    .filter(event => event.code === "KeyY" && ["keydown", "keyup"].includes(event.kind));
  expect(keys.map(event => event.kind)).toEqual(["keydown", "keyup"]);
  expect(keys.every(event => event.isTrusted)).toBe(true);
  expect(await electronDesktopE2eTrustedInputRuntime(input.roleId)).toEqual(submissions);
  const after = (await electronDesktopE2eGameWindowRuntime(input.windowId)).currentRuntime;
  expect(after?.nativeDisplay).toEqual(before?.nativeDisplay);
  expect(after?.windowGeneration).toBe(before?.windowGeneration);
  expect(after?.parentNativeHostId).toBe(before?.parentNativeHostId);
}
