import { $, browser } from "@wdio/globals";
import type { GameWindow, Role } from "../../../src/shared/types";
import { rendererCall } from "../support/renderer-bridge";
import { clickEntityMenuAction, setEditorName, submitEditor, waitForRoute } from "../support/ui";
import { closeVisibleRuntimeWindow } from "../support/native-runtime-tabs";
import { exerciseMacosTabContentFocus } from "./chromium-tab-content-focus";
import { withMacosAnsiInputSource } from "../support/native-application-actions";

/** Independent visible-UI setup keeps tab focus coverage separate from launch admission coverage. */
export async function runMacosTabFocusRegression(input: {
  mainWindowHandle: string;
  createWindow: (name: string) => Promise<GameWindow>;
  launchRole: (role: Role, window: GameWindow) => Promise<string>;
}): Promise<void> {
  const gameName = "Tab Content Focus Game";
  await $(".app-main-sidebar").$("button*=Games").click();
  await waitForRoute("/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(gameName);
  await $("#game-launch-url").setValue(`${process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN}/role/chromium-tabs-focus-game`);
  await submitEditor("/games");
  const game = (await rendererCall("listGames")).find(game => game.name === gameName)!;
  const roles: Role[] = [];
  for (const label of ["Alpha", "Beta"]) {
    await $(".app-main-sidebar").$("button*=Games").click();
    await waitForRoute("/games");
    await clickEntityMenuAction(game.id, "Game actions", "Add role");
    await waitForRoute(`/roles/new?gameId=${game.id}`);
    const name = `Tab Content Focus ${label}`;
    await setEditorName(name);
    await $("#role-launch-url").setValue(`${process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN}/role/chromium-tabs-focus-${label.toLowerCase()}?mode=observe`);
    await submitEditor("/roles");
    let role: Role | undefined;
    await browser.waitUntil(async () => {
      role = (await rendererCall("listRoles")).find(role => role.name === name);
      return !!role;
    }, { timeout: 10_000 });
    roles.push(role!);
  }
  const window = await input.createWindow("Tab Content Focus Window");
  const tabIds: string[] = [];
  for (const role of roles) tabIds.push(await input.launchRole(role, window));
  try {
    await withMacosAnsiInputSource(() =>
      exerciseMacosTabContentFocus({ ...input, roles, tabIds, windowId: window.id }));
  } finally {
    await closeVisibleRuntimeWindow({ platform: "macos", mainWindowHandle: input.mainWindowHandle,
      windowId: window.id, tabId: tabIds.at(-1)!, tabName: roles.at(-1)!.name });
  }
}
