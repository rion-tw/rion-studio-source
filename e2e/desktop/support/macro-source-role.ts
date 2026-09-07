import { $, browser, expect } from "@wdio/globals";
import type { Macro, Role } from "../../../src/shared/types";
import { rendererCall } from "./renderer-bridge";
import { resizeElectronLauncherWindow } from "./extensions-layout";
import { setEditorName, submitEditor } from "./ui";

/** Visible authoring and launch actions; bridge reads are authoritative evidence. */
export async function exerciseSourceRoleMacro(seed: Macro, roles: Role[]): Promise<void> {
  const compactLayout = process.env.RION_STUDIO_E2E_RUNTIME_TARGET?.startsWith("chromium-");
  const originalSize = compactLayout ? await resizeElectronLauncherWindow(960, 640) : undefined;

  const group = await $(`[data-macro-group]:has([data-selection-id='${seed.id}'])`);
  await group.$("button[aria-label='New macro']").click();
  await $("h1=New Macro").waitForDisplayed({ timeout: 10_000 });
  const mode = await $("[role='group'][aria-label='Execution roles']");
  await mode.$("button=Triggering role").click();
  await expect($("button[role='combobox'][aria-label='Execution roles']")).not.toExist();
  await expect($("button=All roles")).toHaveAttribute("aria-pressed", "true");
  expect(await browser.execute(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const name = "Source role execution E2E";
  await setEditorName(name);
  await $("button=Delay").click();
  await $("button=Loop").click();
  await submitEditor("/macros");
  const macro = (await rendererCall("listMacros")).find((candidate) => candidate.name === name);
  if (!macro) throw new Error("Visible source-role macro was not saved");
  expect(macro.executionMode).toBe("source_role");
  expect(macro.roleIds).toEqual([]);
  expect(macro.shortcutSourceScope).toEqual({ type: "all_roles" });
  expect(macro.trigger).toBeUndefined();
  try {
    const row = await $(`[data-selection-id='${macro.id}']`);
    await expect($("[data-macro-group='source_role']")).toHaveText(expect.stringContaining(name));
    await row.$("button[aria-label='Start']").click();
    let dialog = await $("dialog[aria-labelledby='macro-source-title']");
    await dialog.waitForDisplayed({ timeout: 10_000 });
    await dialog.$("button=Cancel").click();
    expect((await rendererCall("listMacroStatuses")).filter((status) => status.macroId === macro.id)).toEqual([]);
    for (const role of roles) {
      await row.$("button[aria-label='Start']").click();
      dialog = await $("dialog[aria-labelledby='macro-source-title']");
      await dialog.waitForDisplayed({ timeout: 10_000 });
      await dialog.$("button[role='combobox']").click();
      await $(`[role='option']=${role.name}`).click();
      await dialog.$("button=Run").click();
      await browser.waitUntil(async () => {
        const statuses = (await rendererCall("listMacroStatuses")).filter((status) => status.macroId === macro.id);
        return statuses.length === 1 && statuses[0].roleId === role.id && statuses[0].state === "running";
      }, { timeout: 20_000, timeoutMsg: "Source macro did not run only on the chosen role" });
      await row.$("button[aria-label='Stop all runs']").click();
      await browser.waitUntil(async () => !(await rendererCall("listMacroStatuses")).some((status) => status.macroId === macro.id), { timeout: 20_000, timeoutMsg: "Source macro did not stop" });
    }
  } finally {
    // Cleanup only; it is not the user action under test.
    await rendererCall("stopMacro", macro.id);
    await rendererCall("deleteMacro", macro.id);
    if (originalSize) await resizeElectronLauncherWindow(originalSize.width, originalSize.height);
  }
}
