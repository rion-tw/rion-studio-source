import { $, browser, expect } from "@wdio/globals";
import type { Role } from "../../../src/shared/types";
import { rendererCall } from "../support/renderer-bridge";
import { clickWorkspaceCreateAction, clickWorkspaceSlot, setEditorName, submitEditor, waitForRoute } from "../support/ui";
import { openCutoverSection } from "../support/chromium-workspace-cutover";
import { electronDesktopE2eWorkspaceWebRuntime } from "../support/electron-driver";
import { exerciseVisibleTabTearout } from "./chromium-tab-tearout";

/** Build a mixed Workspace with the visible editor and launch into the existing
 * multi-tab source. Role, Website and divider projections must transfer together. */
export async function exerciseMixedWorkspaceTearout(input: { mainWindowHandle: string;
  platform: "macos" | "windows"; windowId: string; role: Role }): Promise<void> {
  const name = "Live tearout mixed Workspace";
  await openCutoverSection("Workspaces", "/workspaces");
  await clickWorkspaceCreateAction(); await waitForRoute("/workspaces/new");
  await setEditorName(name);
  await $("#workspace-slot-content").click(); await $("[role='option']=Website").click();
  await clickWorkspaceSlot(1);
  await $("#workspace-slot-content").click(); await $("[role='option']=Role").click();
  await $(`[data-workspace-role-id='${input.role.id}']`).click();
  await submitEditor("/workspaces");
  const workspace = (await rendererCall("listLaunchWorkspaces")).find(w => w.name === name)!;
  expect(workspace.slots).toHaveLength(2);
  await openCutoverSection("Home", "/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForDisplayed({ timeout: 10_000 });
  await palette.$("input[role='combobox']").setValue(name);
  await $(`[data-testid='quick-access-destination-workspace-${workspace.id}']`).click();
  await $(`[data-testid='quick-access-destination-option-window-${input.windowId}']`).click();
  let tabId = "";
  await browser.waitUntil(async () => {
    const tab = (await rendererCall("getEmbeddedRuntimeState")).tabs.find(t => t.sourceId === workspace.id);
    tabId = tab?.id ?? "";
    return !!tab && (await rendererCall("listRoleStatuses")).some(r => r.roleId === input.role.id && r.state === "running");
  }, { timeout: 45_000 });
  let before!: Awaited<ReturnType<typeof electronDesktopE2eWorkspaceWebRuntime>>;
  await browser.waitUntil(async () => {
    before = await electronDesktopE2eWorkspaceWebRuntime(input.windowId);
    return before.tabId === tabId && before.phase === "ready" && before.coreSlots.length === 2;
  }, { timeout: 45_000, timeoutMsg: "The mixed Workspace did not finish its exact initial Role/Website projection" });
  await exerciseVisibleTabTearout({ ...input, tabId, tabName: name, roleId: input.role.id,
    verifyOwner: async windowId => {
      await browser.waitUntil(async () => {
        const current = await electronDesktopE2eWorkspaceWebRuntime(windowId);
        expect(current.web.generation).toBe(before.web.generation);
        expect(current.web.surfaceId).toBe(before.web.surfaceId);
        expect(current.web.contentSessionStoragePath).toBe(before.web.contentSessionStoragePath);
        expect(current.coreSlots).toEqual(before.coreSlots);
        return true;
      }, { timeout: 15_000, timeoutMsg: "The moved mixed Workspace did not publish its exact unchanged surface and slot projection" });
    } });
}
