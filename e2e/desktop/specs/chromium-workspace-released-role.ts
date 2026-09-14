import { $, browser, expect } from "@wdio/globals";
import type { LaunchWorkspace, Role } from "../../../src/shared/types";
import { electronDesktopE2eRoleSessionRuntime } from "../support/electron-driver";
import { clickVisibleElectronPageElement, withRolePageTarget } from "../support/electron-role-surface";
import { closeVisibleRuntimeTab, runtimeTabShellErrors } from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import { openCutoverSection, openCutoverWorkspace, waitCutoverWorkspaceTab } from "../support/chromium-workspace-cutover";

export async function verifyReleasedRolePlaceholder(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  role: Role;
  sibling: Role;
  workspace: LaunchWorkspace;
  shellUrl: string;
}>): Promise<void> {
  for (const destination of ["default", "new-window"] as const) {
    await openCutoverSection("Roles", "/roles");
    const card = await $(`[data-selection-id='${input.role.id}']`);
    await card.scrollIntoView({ block: "center" });
    await card.moveTo();
    await card.$("button[aria-label='Open']").click();
    await browser.waitUntil(async () => (await rendererCall("listRoleStatuses"))
      .some((role) => role.roleId === input.role.id && role.state === "running"), {
      timeout: 45_000, timeoutMsg: "Standalone Role did not start"
    });
    const source = (await rendererCall("getEmbeddedRuntimeState")).tabs.find(
      (tab) => tab.type === "role" && tab.sourceId === input.role.id
    );
    if (!source) throw new Error("Standalone Role tab is missing");
    await openCutoverWorkspace(input.workspace, destination);
    const target = await waitCutoverWorkspaceTab(input.workspace, [
      { roleId: input.role.id, state: "blocked" },
      { roleId: input.sibling.id, state: "running" }
    ]);
    expect(target.windowId === source.windowId).toBe(destination === "default");
    const siblingBefore = (await electronDesktopE2eRoleSessionRuntime(input.sibling.id)).currentRuntime;
    if (!siblingBefore) throw new Error("Sibling Role is not running");
    await closeVisibleRuntimeTab({ ...input,
      tabId: source.id, tabName: source.name, windowId: source.windowId
    });
    await browser.waitUntil(async () => {
      const runtime = await rendererCall("getEmbeddedRuntimeState");
      return !runtime.tabs.some((tab) => tab.id === source.id) &&
        runtime.tabs.find((tab) => tab.id === target.id)?.slots.some((slot) =>
          slot.roleId === input.role.id && slot.state === "available" && !slot.owner);
    }, { timeout: 45_000, timeoutMsg: "Released Role did not become available in its Workspace" });
    expect((await rendererCall("listRoleStatuses")).some((role) => role.roleId === input.role.id)).toBe(false);
    await withRolePageTarget(input.shellUrl, input.mainWindowHandle, async () => {
      await expect($("#message")).toHaveText('This role is open in “another tab”.');
      await expect($("#claim")).toHaveText("Stop there and open here");
      await expect($("#claim")).toBeEnabled();
      await expect($("#error")).not.toBeDisplayed();
    });
    await clickVisibleElectronPageElement(input.shellUrl, input.mainWindowHandle, "#claim");
    const reopened = await waitCutoverWorkspaceTab(input.workspace, [
      { roleId: input.role.id, state: "running" },
      { roleId: input.sibling.id, state: "running" }
    ]);
    expect(reopened.id).toBe(target.id);
    const roleAfter = (await electronDesktopE2eRoleSessionRuntime(input.role.id)).currentRuntime;
    expect(roleAfter).toEqual(expect.objectContaining({ tabId: target.id, windowId: target.windowId }));
    const siblingAfter = (await electronDesktopE2eRoleSessionRuntime(input.sibling.id)).currentRuntime;
    expect(siblingAfter).toEqual(expect.objectContaining({
      generation: siblingBefore.generation, ownerGeneration: siblingBefore.ownerGeneration,
      parentNativeHostId: siblingBefore.parentNativeHostId,
      tabId: siblingBefore.tabId, windowId: siblingBefore.windowId
    }));
    expect(await runtimeTabShellErrors()).toEqual([]);
    await closeVisibleRuntimeTab({ ...input,
      tabId: target.id, tabName: target.name, windowId: target.windowId
    });
  }
}
