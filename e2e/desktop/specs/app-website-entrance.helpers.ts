import { selectGroupedDramaWebsite } from "../support/workspace-web-groups";
import { $, browser, expect } from "@wdio/globals";
import { closeWindowAndWait, keyboardInputSequence, probe, rendererCall, requireEnvironment, runtimeUiAction, waitEvent, windowSnapshot } from "../support/control";
import { clickWorkspaceCreateAction, navigate, setEditorName, submitEditor, waitForRoute } from "../support/ui";
import { waitForWebOnlyRuntimeTab } from "./app-web-only.helpers";

const NAME = "Native Website entrance";

export async function exerciseNativeWebsiteEntrance(restart: boolean): Promise<void> {
  await navigate("/workspaces");
  if (!restart) {
    await clickWorkspaceCreateAction();
    await waitForRoute("/workspaces/new");
    await setEditorName(NAME);
    await $("#workspace-layout").click();
    await $("[data-workspace-layout-option='single']").click();
    await $("#workspace-slot-content").click();
    await $("[role='option']=Website").click();
    await expect($("#workspace-web-name")).toHaveValue("Website");
    await expect($("#workspace-web-url")).toHaveValue("");
    await selectGroupedDramaWebsite();
    await $("#workspace-web-url").clearValue();
    await $("#workspace-web-name").setValue("Website");
    await expect($("#workspace-web-url")).toHaveValue("");
    await submitEditor("/workspaces");
  }
  const workspace = (await rendererCall("listLaunchWorkspaces")).find(item => item.name === NAME);
  if (!workspace) throw new Error("Native entrance workspace was not persisted");
  expect(workspace.slots[0]?.web).toEqual({ name: "Website", startUrl: "" });
  const cursor = (await probe()).latestSequence;
  await navigate("/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForDisplayed({ timeout: 10_000 });
  await palette.$("input[role='combobox']").setValue(NAME);
  await $(`[data-testid='quick-access-destination-workspace-${workspace.id}']`).click();
  await $("[data-testid='quick-access-destination-option-new-window']").click();
  const tab = await waitForWebOnlyRuntimeTab(workspace);
  try {
    await waitEvent({ afterSequence: cursor, kind: `tab-launch-phase:${tab.id}:ready`, windowId: tab.windowId });
  } catch (error) {
    const observed = await windowSnapshot(tab.windowId);
    throw new Error(`${String(error)}; entrance ${JSON.stringify({ kernel: observed.kernel, webviews: observed.native.roleWebviews, chrome: observed.native.workspaceWebChromeSurfaces })}`, { cause: error });
  }
  const snapshot = await windowSnapshot(tab.windowId);
  const surface = snapshot.native.roleWebviews?.find(item => [
    "rion-start://home/", "http://rion-start.home/", "https://rion-start.home/"
  ].includes(item.url ?? ""));
  expect(surface).toBeDefined();
  if (!surface) throw new Error("The native entrance surface is missing");
  expect(tab.roleIds).toEqual([]);
  expect(snapshot.kernel?.tabs.find(item => item.tabId === tab.id)?.workspaceSlots[0]?.web?.startUrl).toBe("");
  const fixtureUrl = `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/e2e-website-entrance`;
  for (const [control, expectedUrl] of [
    ["iqiyi", fixtureUrl], ["home", surface.url], ["back", fixtureUrl],
    ["forward", surface.url], ["reload", surface.url]
  ] as const) {
    const before = (await probe()).latestSequence;
    await runtimeUiAction(tab.windowId, {
      action: "focusWebsiteControl", control, roleId: surface.roleId,
      tabId: tab.id, windowGeneration: snapshot.windowGeneration
    });
    if (control === "iqiyi") {
      const catalog = await waitEvent({ afterSequence: before, kind: "website-entrance-catalog" });
      expect(catalog.details).toMatchObject({
        categories: [
          { id: "media", title: expect.stringMatching(/^Media\s*$/u), count: 15 }, { id: "live", title: expect.stringMatching(/^Live\s*$/u), count: 2 },
          { id: "social", title: expect.stringMatching(/^Social\s*$/u), count: 8 }, { id: "other", title: expect.stringMatching(/^Other\s*$/u), count: 1 }
        ], imagesLoaded: true
      });
    }
    // Real platform keyboard input activates the visible focused card/button.
    await keyboardInputSequence([
      { code: "Enter", phase: "keyDown" }, { code: "Enter", phase: "keyUp" }
    ], false);
    const finished = await waitEvent({
      afterSequence: before, kind: `website-navigation-finished:${surface.webviewLabel}`,
      timeoutMs: 15_000
    }).catch(async error => {
      const current = await windowSnapshot(tab.windowId);
      const receipt = control === "iqiyi" ? null : await waitEvent({
        afterSequence: before, kind: "website-chrome-action", timeoutMs: 1000
      }).catch(() => null);
      throw new Error(`Website ${control} failed: ${String(error)}; ${JSON.stringify({ views: current.native.roleWebviews, receipt })}`, { cause: error });
    });
    expect(finished.details).toMatchObject({ url: expectedUrl });
  }
  expect((await rendererCall("listLaunchWorkspaces")).find(item => item.id === workspace.id)?.slots[0]?.web?.startUrl).toBe("");
  // A one-tab AppKit window hides its tab-close control. Close the isolated
  // native window after recording the entrance evidence instead.
  await closeWindowAndWait(snapshot);
  await browser.waitUntil(async () => !(await rendererCall("getEmbeddedRuntimeState")).tabs.some(item => item.id === tab.id),
    { timeout: 15_000, timeoutMsg: "Native entrance did not close" });
  if ((await rendererCall("listGameWindows")).some(item => item.id === tab.windowId)) {
    await rendererCall("deleteGameWindow", tab.windowId);
  }
}
