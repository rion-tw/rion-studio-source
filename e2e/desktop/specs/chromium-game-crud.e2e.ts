import { $, browser, expect } from "@wdio/globals";

import type { Game } from "../../../src/shared/types";
import { electronDesktopE2eProbe } from "../support/electron-driver";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  clickConfirmation,
  clickEntityMenuAction,
  ensureEnglishUi,
  setEditorName,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-GAME-CRUD-002]
// [journey:CHROMIUM-WINDOWS-GAME-CRUD-002]
// [journey:CHROMIUM-MACOS-APPKIT-LEGAL-007]
// [journey:CHROMIUM-WINDOWS-LEGAL-007]
// [journey:CHROMIUM-MACOS-APPKIT-PRIMARY-NAV-008]
// [journey:CHROMIUM-WINDOWS-PRIMARY-NAV-008]

const GAME_NAME = "Chromium E2E Game";
const GAME_NAME_EDITED = "Chromium E2E Game Edited";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium desktop E2E journey`);
  return value;
}

async function findGame(name: string): Promise<Game> {
  let game: Game | undefined;
  await browser.waitUntil(async () => {
    game = (await rendererCall("listGames")).find((candidate) => candidate.name === name);
    return Boolean(game);
  }, {
    timeout: 15_000,
    timeoutMsg: `Chromium journey did not observe the authoritative Game ${name}`
  });
  return game as Game;
}

async function openGamesThroughVisibleNavigation(): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  await sidebar.$("button*=Games").click();
  await waitForRoute("/games");
}

async function exercisePrimaryNavigation(): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  for (const [label, route] of [
    ["Games", "/games"],
    ["Roles", "/roles"],
    ["Workspaces", "/workspaces"],
    ["Windows", "/game-windows"],
    ["Macros", "/macros"],
    ["Home", "/dashboard"]
  ] as const) {
    await sidebar.$(`button*=${label}`).click();
    await waitForRoute(route);
  }
  await sidebar.$("button*=Settings").click();
  await waitForRoute("/settings");
  await $("button=Back to app").click();
  await waitForRoute("/dashboard");
}

async function assertRuntimeTarget(): Promise<void> {
  const probe = await electronDesktopE2eProbe();
  const runtimeTarget = required("RION_STUDIO_E2E_RUNTIME_TARGET");
  expect(probe.runtimeTarget).toBe(runtimeTarget);
  expect(probe.driver).toBe("electron");
  expect(probe.packaged).toBe(false);
  expect(probe.chromeVersion).toMatch(/^\d+\./u);
  expect(probe.electronVersion).toMatch(/^\d+\./u);

  const gestureMode = await browser.execute(() =>
    document.documentElement.dataset.windowGestureMode
  );
  if (runtimeTarget === "chromium-v23-macos-appkit") {
    expect(probe.platform).toBe("macos");
    expect(gestureMode).toBe("native-non-client");
  } else if (runtimeTarget === "chromium-v23-windows") {
    expect(probe.platform).toBe("windows");
    expect(gestureMode).toBe("native-non-client");
  } else {
    throw new Error(`Unexpected Chromium desktop E2E target ${runtimeTarget}`);
  }
}

async function createAndEditGameThroughVisibleUi(): Promise<void> {
  await openGamesThroughVisibleNavigation();
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(GAME_NAME);

  const launchUrl = await $("#game-launch-url");
  await launchUrl.setValue("invalid-launch-url");
  await expect($("#app-editor-form button[type='submit']")).toBeDisabled();
  const expectedUrl = `${required("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/chromium-game-crud`;
  await launchUrl.setValue(expectedUrl);
  await submitEditor("/games");

  const created = await findGame(GAME_NAME);
  expect(created.defaultLaunchUrl).toBe(expectedUrl);
  const card = await $(`[data-selection-id='${created.id}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  await card.$("./button[1]").click();
  await waitForRoute(`/games/${created.id}/edit`);
  await setEditorName(GAME_NAME_EDITED);
  await submitEditor("/games");

  const edited = await findGame(GAME_NAME_EDITED);
  expect(edited.id).toBe(created.id);
  expect(edited.defaultLaunchUrl).toBe(expectedUrl);
  expect((await rendererCall("listGames")).some((game) => game.name === GAME_NAME)).toBe(false);
}

async function verifyRestartThroughVisibleUi(): Promise<void> {
  await openGamesThroughVisibleNavigation();
  const game = await findGame(GAME_NAME_EDITED);
  const card = await $(`[data-selection-id='${game.id}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  expect(await card.getText()).toContain(GAME_NAME_EDITED);
  await card.$("./button[1]").click();
  await waitForRoute(`/games/${game.id}/edit`);
  await expect($("#game-name")).toHaveValue(GAME_NAME_EDITED);
  await expect($("#game-launch-url")).toHaveValue(
    `${required("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/chromium-game-crud`
  );

  await openGamesThroughVisibleNavigation();
  await clickEntityMenuAction(game.id, "Game actions", "Delete");
  await clickConfirmation("Cancel");
  expect((await rendererCall("listGames")).some((candidate) => candidate.id === game.id))
    .toBe(true);
  await clickEntityMenuAction(game.id, "Game actions", "Delete");
  await clickConfirmation("Delete");
  await browser.waitUntil(
    async () => !(await rendererCall("listGames"))
      .some((candidate) => candidate.id === game.id),
    {
      timeout: 15_000,
      timeoutMsg: "Chromium Game remained after visible delete confirmation"
    }
  );
  await $(`[data-selection-id='${game.id}']`).waitForExist({
    reverse: true,
    timeout: 10_000
  });
}

describe("Chromium persisted Game journey", () => {
  it("uses visible UI for validation, creation, editing, restart, and deletion", async () => {
    await assertRuntimeTarget();
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();

    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-game-crud-seed") {
      await exercisePrimaryNavigation();
      await createAndEditGameThroughVisibleUi();
      return;
    }
    if (phase === "chromium-game-crud-restart") {
      await verifyRestartThroughVisibleUi();
      return;
    }
    throw new Error(`Unexpected Chromium Game journey phase ${phase}`);
  });
});
