import { $, browser } from "@wdio/globals";
import { rendererCall } from "./renderer-bridge";
import { waitForRoute } from "./ui";
import { electronDesktopE2eProbe } from "./electron-driver";
import { closeVisibleRuntimeTab } from "./native-runtime-tabs";
import { selectMacosVisibleRuntimeTabMenuAction } from "./macos-appkit-ui";

const EXTENSION_ID = "gighmmpiobklfepjocnamgkkbiglidom";

export async function extensionTerminalIds(): Promise<string[]> {
  const page = await rendererCall("queryLogs", { sources: ["extension"], limit: 200 });
  return page.entries.filter(entry => entry.event === "extension_runtime_terminal").map(entry => entry.id);
}

export async function expectExtensionPassedClassification(roleId: string, previousIds: string[]): Promise<void> {
  const previous = new Set(previousIds);
  let terminalFailure: string | undefined;
  await browser.waitUntil(async () => {
    const page = await rendererCall("queryLogs", { sources: ["extension"], limit: 200 });
    const terminals = page.entries.filter(entry => !previous.has(entry.id) &&
      entry.event === "extension_runtime_terminal" && entry.context?.roleId === roleId &&
      entry.context?.extensionId === EXTENSION_ID);
    const rejected = terminals.find(entry => entry.context?.stage === "classification" ||
      entry.context?.code === "ELECTRON_EXTENSION_BOOTSTRAP_DEADLINE_EXCEEDED");
    if (rejected) {
      terminalFailure = JSON.stringify(rejected.context);
      return true;
    }
    // Native running plus the exact compatibility receipt proves successful
    // bootstrap; generic degraded or deadline outcomes never count as success.
    // Post-navigation API/DNR behavior has a separate acceptance gate. In
    // particular, native allocation updates after restart can fail after READY.
    return terminals.some(entry => entry.context?.code === "ELECTRON_EXTENSION_READY" &&
      entry.context?.stage === "bootstrap" && entry.context?.status === "loaded");

  }, { timeout: 30_000, timeoutMsg: "AdBlock did not reach native worker running and compatibility readiness" });
  if (terminalFailure) throw new Error(`AdBlock native extension classification failed: ${terminalFailure}`);
}

export async function verifyExtensionPermissionsAfterRestart(): Promise<void> {
  const main = await browser.getWindowHandle();
  const role = (await rendererCall("listRoles")).find(candidate => candidate.name === "Future extensions role");
  if (!role) throw new Error("The persisted extension role is missing");
  await $(".app-main-sidebar").$("button*=Roles").click();
  await waitForRoute("/roles");
  const previous = await extensionTerminalIds();
  await $(`[data-selection-id='${role.id}']`).moveTo();
  await $(`[data-selection-id='${role.id}']`).$("button[aria-label='Open']").click();
  await browser.switchToWindow(main);
  await expectExtensionPassedClassification(role.id, previous);
  await browser.waitUntil(async () => (await rendererCall("listRoleStatuses")).some(status => status.roleId === role.id && status.state === "running"), { timeout: 30_000 });
  const tab = (await rendererCall("getEmbeddedRuntimeState")).tabs.find(candidate => candidate.sourceId === role.id);
  if (!tab) throw new Error("The reopened extension role has no native tab");
  const { platform } = await electronDesktopE2eProbe();
  if (platform === "macos") {
    await selectMacosVisibleRuntimeTabMenuAction({ action: "stop", tabId: tab.id, tabName: role.name, windowId: tab.windowId });
  } else {
    await closeVisibleRuntimeTab({ mainWindowHandle: main, platform: "windows", tabId: tab.id, tabName: role.name, windowId: tab.windowId });
  }
  await browser.switchToWindow(main);
  await browser.waitUntil(async () => !(await rendererCall("extensions", { type: "snapshot" })).snapshot.roles
    .some(candidate => candidate.roleId === role.id), { timeout: 30_000 });
  await $(".app-main-sidebar").$("button*=Extensions").click();
  await waitForRoute("/extensions");
}
