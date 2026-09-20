import { $, browser, expect } from "@wdio/globals";
import { navigateVisibleElectronWorkspaceWebChrome, withRolePageTarget } from "./electron-role-surface";
import { fixtureCursor, waitFixtureEvent } from "./fixture";
import { runtimeTabShellErrors } from "./native-runtime-tabs";
import { rendererCall } from "./renderer-bridge";

/** Primary actions use the visible website and toolbar. Native readback is
 * evidence only; the local server supplies a held response and a socket failure.
 */
export async function verifyWorkspaceWebNavigation(input: {
  chromeShellUrl: string;
  contentUrl: string;
  mainWindowHandle: string;
  roleIds: readonly string[];
}): Promise<void> {
  const fixture = new URL("/web-navigation", process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN!).href;
  const home = "rion-start://home/";
  const baselineErrors = await runtimeTabShellErrors();
  const contentId = await browser.electron.execute((electron, url) => {
    const contents = electron.webContents.getAllWebContents().filter(wc => wc.getURL() === url);
    if (contents.length !== 1) throw new Error("Expected the exact Workspace Web surface");
    return contents[0].id;
  }, input.contentUrl);
  const navigate = (url: string) => navigateVisibleElectronWorkspaceWebChrome(
    input.chromeShellUrl, input.mainWindowHandle, url
  );
  const button = async (id: string) => withRolePageTarget(input.chromeShellUrl, input.mainWindowHandle, async () => {
    await $(`#${id}`).waitForEnabled({ timeout: 10_000 });
    await $(`#${id}`).click();
  });
  const waitUrl = async (url: string) => browser.waitUntil(async () => browser.electron.execute(
    (electron, id, expected) => electron.webContents.fromId(id)?.getURL() === expected, contentId, url
  ), { timeout: 15_000, timeoutMsg: `Web toolbar did not navigate to ${url}` });
  const expectHome = async () => {
    await waitUrl(home);
    await withRolePageTarget(home, input.mainWindowHandle, async () => {
      await expect($("[data-workspace-drm-notice]")).toBeDisplayed();
      await expect($("[data-workspace-drm-notice]")).toHaveText(expect.stringContaining("DRM"));
    });
  };
  await navigate(fixture);
  await waitUrl(fixture);
  await withRolePageTarget(fixture, input.mainWindowHandle, async () => {
    await $("#history-one").click();
    await $("#history-two").click();
  });
  await waitUrl(`${fixture}#two`);
  await button("back");
  await waitUrl(`${fixture}#one`);
  await button("forward");
  await waitUrl(`${fixture}#two`);
  await button("home");
  await expectHome();

  const cursor = await fixtureCursor();
  await navigate(`${fixture}/slow`);
  await waitFixtureEvent({ afterSequence: cursor, kind: "web-navigation-slow-started", roleId: "workspace-web-navigation" });
  await button("home");
  await expectHome();
  await waitFixtureEvent({ afterSequence: cursor, kind: "web-navigation-slow-cancelled", roleId: "workspace-web-navigation" });

  await navigate(`${fixture}/fail`);
  await withRolePageTarget(input.chromeShellUrl, input.mainWindowHandle, async () => {
    await expect($("#navigation-status")).toHaveAttribute("data-failed", "true");
    await expect($("#navigation-status")).toHaveText("Page could not load. Reload or go home.");
    await $("#home").click();
  });
  await expectHome();
  const statuses = await rendererCall("listRoleStatuses");
  for (const roleId of input.roleIds) expect(statuses.find(role => role.roleId === roleId)?.state).toBe("running");
  expect(await runtimeTabShellErrors()).toEqual(baselineErrors);
  await navigate(input.contentUrl);
  await waitUrl(input.contentUrl);
}
