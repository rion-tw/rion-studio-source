import { $, browser } from "@wdio/globals";
import type { GameWindow, Role } from "../../../src/shared/types";
import { rendererCall } from "../support/renderer-bridge";
import { clickEntityMenuAction, setEditorName, submitEditor, waitForRoute } from "../support/ui";
import { closeVisibleRuntimeWindow } from "../support/native-runtime-tabs";
import { exerciseTabContentFocus } from "./chromium-tab-content-focus";
import { pressVisibleWindowsApplicationShortcut, withMacosAnsiInputSource } from "../support/native-application-actions";
import { electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eProbe } from "../support/electron-driver";

/** Independent visible-UI setup keeps tab focus coverage separate from launch admission coverage. */
export async function runTabFocusRegression(input: {
  platform: "macos" | "windows";
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
  const failures: unknown[] = [];
  try {
    const exercise = () => exerciseTabContentFocus({ ...input, roles, tabIds, windowId: window.id });
    if (input.platform === "macos") await withMacosAnsiInputSource(exercise);
    else await exercise();
  } catch (error) { failures.push(error); }
  try {
    if (input.platform === "windows") {
      const state = await electronDesktopE2eFullscreenToolbarRuntime(window.id);
      if (state.presentation === "fullscreen") {
        await pressVisibleWindowsApplicationShortcut({ command: "toggleFullscreen",
          processId: (await electronDesktopE2eProbe()).processId,
          nativeWindowHandle: state.nativeWindowHandle!, targetMode: "focused-runtime" });
      }
    }
    await closeVisibleRuntimeWindow({ platform: input.platform, mainWindowHandle: input.mainWindowHandle,
      windowId: window.id, tabId: tabIds.at(-1)!, tabName: roles.at(-1)!.name });
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures,
    `Tab focus regression and cleanup failed: ${failures.map(String).join("; ")}`);
}
