import { expect } from "@wdio/globals";
import type { Macro } from "../../../src/shared/types";
import { electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eProbe } from "../support/electron-driver";
import { readVisibleElectronCanvasPoint } from "../support/electron-role-surface";
import { fixtureCursor, fixtureEvents, fixtureState } from "../support/fixture";
import { clickMacosVisibleRoleControl } from "../support/macos-appkit-ui";
import { pressVisibleMacosRoleKey, pressVisibleWindowsApplicationShortcut,
  type VisibleFunctionKey } from "../support/native-application-actions";
import { rendererCall } from "../support/renderer-bridge";
import { rendererEventCursor, waitForMacroProjection } from "../support/renderer-events";
import { focusWindowsRoleCanvas } from "../support/windows-role-canvas";
import { writeChromiumMacroEvidence } from "./chromium-macro-cutover-support";

export async function createFunctionKeyMacros(roleId: string): Promise<Macro[]> {
  const macros: Macro[] = [];
  for (let number = 1; number <= 12; number++) for (const ctrl of [false, true]) {
    macros.push(await rendererCall("createMacro", {
      activationMode: "press", enabled: true, name: `Function ${ctrl ? "Ctrl+" : ""}F${number}`,
      repeat: { type: "once" }, roleIds: [roleId],
      shortcutSourceScope: { type: "selected_roles", roleIds: [roleId] },
      trigger: { code: `F${number}`, ctrl, alt: false, meta: false, shift: false },
      steps: [{ id: "function-output", type: "key", code: "Digit7", action: "tap" }]
    }));
  }
  return macros;
}

export async function exerciseFunctionKeyMacros(input: Readonly<{
  platform: "macos" | "windows"; roleId: string; roleName: string; fixtureRoleId: string;
  windowId: string; launchUrl: string; mainWindowHandle: string; macros: readonly Macro[];
}>): Promise<void> {
  const processId = (await electronDesktopE2eProbe()).processId;
  if (input.platform === "macos") {
    await clickMacosVisibleRoleControl(input.windowId, input.roleId,
      await readVisibleElectronCanvasPoint(input.launchUrl, input.mainWindowHandle));
  } else await focusWindowsRoleCanvas({ ...input, fixtureId: input.fixtureRoleId });
  const before = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
  const results = [];
  const cases: Array<Record<string, unknown>> = [];
  const savePartial = () => writeChromiumMacroEvidence("chromium-macro-function-keys-partial.json", {
    platform: input.platform, roleId: input.roleId, windowId: input.windowId, before, cases
  }).catch(captureError => console.warn("Partial function-key evidence write failed", String(captureError)));
  for (const macro of input.macros) {
    if (!macro.trigger || !("code" in macro.trigger)) throw new Error("Missing function-key fixture trigger");
    const code = `${macro.trigger.ctrl ? "Ctrl+" : ""}${macro.trigger.code}` as VisibleFunctionKey;
    const afterSequence = await fixtureCursor();
    const projection = await rendererEventCursor();
    const evidence = { code, macroId: macro.id, fixtureCursor: afterSequence,
      rendererCursor: projection, startedAt: new Date().toISOString() };
    const index = cases.push({ ...evidence, status: "started" }) - 1;
    await savePartial();
    try {
      if (input.platform === "macos") await pressVisibleMacosRoleKey({ code, processId,
        runtimeTabName: input.roleName, runtimeWindowId: input.windowId });
      else await pressVisibleWindowsApplicationShortcut({ command: code, processId, targetMode: "focused-runtime" });
      cases[index] = { ...cases[index], nativeHelperReturnedAt: new Date().toISOString() };
      await savePartial();
      await waitForMacroProjection({ absent: true, afterSequence: projection, macroId: macro.id });
      let events: Awaited<ReturnType<typeof fixtureEvents>> = [];
      await browser.waitUntil(async () => {
        events = (await Promise.all(["consumer-keydown", "consumer-keyup"].map(kind =>
          fixtureEvents({ afterSequence, roleId: input.fixtureRoleId, kind })))).flat()
          .sort((left, right) => left.sequence - right.sequence);
        return events.some(event => event.kind === "consumer-keyup" && event.code === "Digit7");
      }, { timeout: 10_000, timeoutMsg: `${code} did not complete its Macro output` });
      expect(events.filter(event => event.code === "Digit7" &&
        ["consumer-keydown", "consumer-keyup"].includes(event.kind)).map(event => event.kind))
        .toEqual(["consumer-keydown", "consumer-keyup"]);
      const after = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
      expect(after.presentation).toBe(before.presentation);
      expect(after.native.fullscreen).toBe(before.native.fullscreen);
      expect(after.surfaces).toEqual(before.surfaces);
      results.push({ code, events, presentation: after.presentation });
      const physical = await fixtureEvents({ afterSequence, roleId: input.fixtureRoleId }).then(
        value => ({ events: value, error: null }),
        error => ({ events: [], error: String(error) })
      );
      cases[index] = { ...cases[index], status: "completed", completedAt: new Date().toISOString(),
        fixtureEvents: [...physical.events, ...events].sort((left, right) => left.sequence - right.sequence),
        physicalObservationError: physical.error, runtime: after };
      await savePartial();
    } catch (error) {
      cases[index] = { ...cases[index], status: "failed", failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error) };
      await savePartial();
      const observed = await Promise.allSettled([
        fixtureEvents({ afterSequence, roleId: input.fixtureRoleId }),
        fixtureEvents({ afterSequence, roleId: input.fixtureRoleId, kind: "consumer-keydown" }),
        fixtureEvents({ afterSequence, roleId: input.fixtureRoleId, kind: "consumer-keyup" }),
        electronDesktopE2eFullscreenToolbarRuntime(input.windowId)
      ]);
      cases[index] = { ...cases[index], failureObservations: observed.map((result, observationIndex) =>
        result.status === "fulfilled" ? { observationIndex, value: result.value }
          : { observationIndex, error: String(result.reason) }) };
      await savePartial();
      throw error;
    }
  }
  await browser.waitUntil(async () => (await fixtureState())[input.fixtureRoleId]?.consumerPressedCodes.length === 0,
    { timeout: 5000, timeoutMsg: "Function-key lifecycle left a pressed consumer key" });
  await writeChromiumMacroEvidence("chromium-macro-function-keys.json", { platform: input.platform, results });
}
