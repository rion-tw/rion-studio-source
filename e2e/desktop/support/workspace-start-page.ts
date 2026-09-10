import { $, browser, expect } from "@wdio/globals";

import type { LaunchWorkspace } from "../../../src/shared/types";
import { electronDesktopE2eWorkspaceWebRuntime } from "./electron-driver";
import { switchTrackedWindow, withRolePageTarget } from "./electron-role-surface";
import { openCutoverWorkspace } from "./chromium-workspace-cutover";
import { rendererCall } from "./renderer-bridge";
import { closeVisibleRuntimeTab } from "./native-runtime-tabs";
import {
  clickWorkspaceCreateAction,
  setEditorName,
  submitEditor,
  waitForRoute
} from "./ui";

const NAME = "Website entrance persistence";
const START = "rion-start://home/";

async function findWorkspace(): Promise<LaunchWorkspace> {
  const workspace = (await rendererCall("listLaunchWorkspaces"))
    .find((item) => item.name === NAME);
  if (!workspace) throw new Error("The entrance workspace was not persisted");
  return workspace;
}

async function waitForRuntime(workspace: LaunchWorkspace): Promise<Readonly<{
  inspection: Awaited<ReturnType<typeof electronDesktopE2eWorkspaceWebRuntime>>;
  tabId: string;
  windowId: string;
}>> {
  let result: Readonly<{
    inspection: Awaited<ReturnType<typeof electronDesktopE2eWorkspaceWebRuntime>>;
    tabId: string;
    windowId: string;
  }> | undefined;
  await browser.waitUntil(async () => {
    const tab = (await rendererCall("getEmbeddedRuntimeState")).tabs.find(
      (item) => item.sourceId === workspace.id
    );
    if (!tab) return false;
    try {
      result = {
        inspection: await electronDesktopE2eWorkspaceWebRuntime(tab.windowId),
        tabId: tab.id,
        windowId: tab.windowId
      };
      return true;
    } catch {
      return false;
    }
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: "The Rion entrance Workspace did not reach its Chromium surface"
  });
  return result!;
}

async function closeWorkspace(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  tabId: string;
  windowId: string;
}>): Promise<void> {
  await switchTrackedWindow(input.mainWindowHandle);
  await closeVisibleRuntimeTab({ ...input, tabName: NAME });
}

async function expectEntranceCatalog(mainWindowHandle: string): Promise<void> {
  await withRolePageTarget(START, mainWindowHandle, async () => {
    await expect($("[data-rion-workspace-start]")).toBeDisplayed();
    expect(await browser.$$("[data-workspace-start-site]")).toHaveLength(26);
    expect(await $("input").isExisting()).toBe(false);
    const groups = await browser.$$("[data-workspace-start-category]");
    expect(await groups.map((group) =>
      group.getAttribute("data-workspace-start-category")
    )).toEqual(["media", "live", "social", "other"]);
    for (const [id, count] of [
      ["media", 15], ["live", 2], ["social", 8], ["other", 1]
    ] as const) {
      expect(await $(`[data-workspace-start-category='${id}']`).$$("a"))
        .toHaveLength(count);
    }
  });
}

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
    expect(await $("#workspace-web-name").isExisting()).toBe(false);
    expect(await $("#workspace-web-url").isExisting()).toBe(false);
    expect(await $("[data-workspace-web-preset-select]").isExisting()).toBe(false);
    await submitEditor("/workspaces");
  }

  let workspace = await findWorkspace();
  expect(workspace.slots[0]?.web).toEqual(
    input.restart ? { lastUrl: input.fixtureUrl } : {}
  );
  await openCutoverWorkspace(workspace, "new-window");
  let runtime = await waitForRuntime(workspace);

  if (!input.restart) {
    expect(runtime.inspection.web.contentUrl).toBe(START);
    await expectEntranceCatalog(input.mainWindowHandle);
    const contentId = await browser.electron.execute((electron, start, fixtureUrl) => {
      const content = electron.webContents.getAllWebContents().find(
        (webContents) => webContents.getURL() === start
      );
      if (!content) throw new Error("Entrance content is missing");
      content.session.webRequest.onBeforeRequest(
        { urls: ["https://www.iq.com/*"] },
        (_request, callback) => callback({ redirectURL: fixtureUrl })
      );
      return content.id;
    }, START, input.fixtureUrl);
    try {
      await withRolePageTarget(START, input.mainWindowHandle, async () => {
        const card = await $("[data-workspace-start-site='iqiyi']");
        await card.scrollIntoView({ block: "center" });
        await card.click();
      });
      await browser.waitUntil(async () => {
        workspace = await findWorkspace();
        runtime = await waitForRuntime(workspace);
        return runtime.inspection.web.contentUrl === input.fixtureUrl &&
          workspace.slots[0]?.web?.lastUrl === input.fixtureUrl;
      }, {
        interval: 100,
        timeout: 20_000,
        timeoutMsg: "The entrance card navigation was not durably committed"
      });
    } finally {
      await switchTrackedWindow(input.mainWindowHandle);
      await browser.electron.execute((electron, id) => {
        electron.webContents.fromId(id)?.session.webRequest.onBeforeRequest(null);
      }, contentId);
    }
    await closeWorkspace({ ...input, ...runtime });
    return;
  }

  expect(runtime.inspection.web.contentUrl).toBe(input.fixtureUrl);
  await withRolePageTarget(
    runtime.inspection.web.chromeShellUrl,
    input.mainWindowHandle,
    async () => {
      await $("#home").click();
    }
  );
  await browser.waitUntil(async () => {
    workspace = await findWorkspace();
    runtime = await waitForRuntime(workspace);
    return runtime.inspection.web.contentUrl === START &&
      workspace.slots[0]?.web?.lastUrl === undefined;
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: "Home did not clear the Workspace Web continuation URL"
  });
  await expectEntranceCatalog(input.mainWindowHandle);
  await closeWorkspace({ ...input, ...runtime });

  await openCutoverWorkspace(workspace, "new-window");
  runtime = await waitForRuntime(workspace);
  expect(runtime.inspection.web.contentUrl).toBe(START);
  await expectEntranceCatalog(input.mainWindowHandle);
  await closeWorkspace({ ...input, ...runtime });
}
