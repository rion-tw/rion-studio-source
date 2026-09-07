import { openCutoverWorkspace } from "./chromium-workspace-cutover";
import { $, browser, expect } from "@wdio/globals";
import { switchTrackedWindow, withRolePageTarget } from "./electron-role-surface";
import { rendererCall } from "./renderer-bridge";
import { closeVisibleRuntimeTab } from "./native-runtime-tabs";
import { clickWorkspaceCreateAction, setEditorName, submitEditor, waitForRoute } from "./ui";

const NAME = "Website entrance persistence";
const START = "rion-start://home/";

export async function verifyWorkspaceStartPage(input: {
  mainWindowHandle: string;
  platform: "macos" | "windows";
  restart: boolean;
  fixtureUrl: string;
}): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.$("button*=Workspaces").click();
  await waitForRoute("/workspaces");
  if (!input.restart) {
    await clickWorkspaceCreateAction();
    await waitForRoute("/workspaces/new");
    await setEditorName(NAME);
    await $("#workspace-layout").click();
    await $("[data-workspace-layout-option='single']").click();
    await $("#workspace-slot-content").click();
    await $("[role='option']=Website").click();
    await expect($("#workspace-web-name")).toHaveValue("Website");
    await expect($("#workspace-web-url")).toHaveValue("");
    await submitEditor("/workspaces");
  }
  const workspace = (await rendererCall("listLaunchWorkspaces")).find(item => item.name === NAME);
  if (!workspace) throw new Error("The entrance workspace was not persisted");
  expect(workspace.slots[0]?.web).toEqual({ name: "Website", startUrl: "" });
  await openCutoverWorkspace(workspace, "new-window");
  await withRolePageTarget(START, input.mainWindowHandle, async () => {
    await expect($("[data-rion-workspace-start]")).toBeDisplayed();
    expect(await browser.$$("[data-workspace-start-site]")).toHaveLength(12);
    expect(await $("input").isExisting()).toBe(false);
  });
  const identity = await browser.electron.execute((electron, start, fixtureUrl) => {
    const content = electron.webContents.getAllWebContents().find(wc => wc.getURL() === start);
    if (!content) throw new Error("Entrance content is missing");
    content.session.webRequest.onBeforeRequest({ urls: ["https://www.youtube.com/*"] },
      (_request, callback) => callback({ redirectURL: fixtureUrl }));
    const chrome = electron.webContents.getAllWebContents().filter(wc => wc.getURL().includes("runtime-web-chrome-electron.html"));
    return { contentId: content.id, chromeIds: chrome.map(wc => wc.id) };
  }, START, input.fixtureUrl);
  try {
    // The card click is the primary action; the session hook supplies a deterministic response.
    await withRolePageTarget(START, input.mainWindowHandle, async () => {
      await $("[data-workspace-start-site='youtube']").click();
    });
    await browser.waitUntil(async () => browser.electron.execute((electron, id, url) =>
      electron.webContents.fromId(id)?.getURL() === url, identity.contentId, input.fixtureUrl),
    { timeout: 15_000, timeoutMsg: "The visible card did not navigate to its bounded fixture" });
    let chromeHandle: string | undefined;
    for (const handle of await browser.getWindowHandles()) {
      if (handle === input.mainWindowHandle) continue;
      await switchTrackedWindow(handle);
      if (await browser.execute((url) => document.querySelector<HTMLInputElement>("#location")?.value === url, input.fixtureUrl)) {
        chromeHandle = handle;
        break;
      }
    }
    if (!chromeHandle) throw new Error("No chrome represents the entrance navigation");
    await $("#home").click();
    await expect($("#location")).toHaveValue("");
    await $("#location").click();
    await expect($("#location")).toHaveValue("");
    await $("#back").click();
    await expect($("#location")).toHaveValue(input.fixtureUrl);
    await $("#forward").click();
    await expect($("#location")).toHaveValue("");
    await $("#reload").click();
    await expect($("#location")).toHaveValue("");
    await switchTrackedWindow(input.mainWindowHandle);
    await withRolePageTarget(START, input.mainWindowHandle, async () => {
      await expect($("[data-rion-workspace-start]")).toBeDisplayed();
    });
    expect((await rendererCall("listLaunchWorkspaces")).find(item => item.id === workspace.id)?.slots[0]?.web?.startUrl).toBe("");
  } finally {
    await switchTrackedWindow(input.mainWindowHandle);
    await browser.electron.execute((electron, id) => {
      electron.webContents.fromId(id)?.session.webRequest.onBeforeRequest(null);
    }, identity.contentId);
    const tab = (await rendererCall("getEmbeddedRuntimeState")).tabs.find(item => item.sourceId === workspace.id);
    if (tab) await closeVisibleRuntimeTab({
      ...input, tabId: tab.id, tabName: workspace.name, windowId: tab.windowId
    });
  }
}
