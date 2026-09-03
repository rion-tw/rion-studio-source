import { readFile, watch } from "node:fs/promises";
import { resolve } from "node:path";

import { $, browser, expect } from "@wdio/globals";

import { electronDesktopE2eProbe } from "../support/electron-driver";
import { pressVisibleNativeApplicationQuit } from
  "../support/native-application-actions";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  ensureEnglishUi,
  setEditorName,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-QUIT-GUARD-014]
// [journey:CHROMIUM-WINDOWS-QUIT-GUARD-014]

const UNSAVED_GAME_NAME = "Chromium Unsaved Quit Guard Game";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium quit-guard journey`);
  return value;
}

async function openNewGameThroughVisibleUi(): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  await sidebar.$("button*=Games").click();
  await waitForRoute("/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
}

async function openQuitDialog() {
  await pressVisibleNativeApplicationQuit();
  const dialog = await $("dialog[open]");
  await dialog.waitForDisplayed({ timeout: 15_000 });
  return dialog;
}

async function waitForGuardedFinalFlush(): Promise<void> {
  const artifactDirectory = required("RION_STUDIO_E2E_ARTIFACT_DIR");
  const markerPath = resolve(artifactDirectory, "electron-final-flush.json");
  const readMarker = async () => JSON.parse(await readFile(markerPath, "utf8")) as {
    complete?: boolean;
    phase?: string;
    pid?: number;
    runtimeTarget?: string;
  };
  try {
    const marker = await readMarker();
    expect(marker).toEqual(expect.objectContaining({
      complete: true,
      phase: "chromium-quit-guard-seed",
      runtimeTarget: required("RION_STUDIO_E2E_RUNTIME_TARGET")
    }));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const changes = watch(artifactDirectory, { signal: AbortSignal.timeout(30_000) });
  for await (const change of changes) {
    if (change.filename !== "electron-final-flush.json") continue;
    const marker = await readMarker();
    expect(marker).toEqual(expect.objectContaining({
      complete: true,
      phase: "chromium-quit-guard-seed",
      runtimeTarget: required("RION_STUDIO_E2E_RUNTIME_TARGET")
    }));
    return;
  }
  throw new Error("Renderer-confirmed Chromium quit did not reach final flush");
}

async function seedPhase(): Promise<void> {
  await openNewGameThroughVisibleUi();
  await setEditorName(UNSAVED_GAME_NAME);

  const firstDialog = await openQuitDialog();
  await firstDialog.$("button=Keep editing").click();
  await firstDialog.waitForExist({ reverse: true, timeout: 10_000 });
  await expect($("#app-editor-form input[name='name']"))
    .toHaveValue(UNSAVED_GAME_NAME);
  expect(await browser.execute(() => window.location.hash)).toBe("#/games/new");
  expect((await rendererCall("listGames")).some(
    (game) => game.name === UNSAVED_GAME_NAME
  )).toBe(false);

  const secondDialog = await openQuitDialog();
  // The application now owns shutdown; the WebDriver after-hook must not inject
  // its separate clean-close path after the visible discard decision.
  process.env.RION_STUDIO_E2E_TERMINAL_NATIVE_QUIT = "1";
  await secondDialog.$("button=Discard changes").click().catch(() => undefined);
  await waitForGuardedFinalFlush();
}

async function restartPhase(): Promise<void> {
  expect((await rendererCall("listGames")).some(
    (game) => game.name === UNSAVED_GAME_NAME
  )).toBe(false);
  await openNewGameThroughVisibleUi();
  await expect($("#app-editor-form input[name='name']")).toHaveValue("");
}

describe("Chromium application quit guard", () => {
  it("keeps editing once, visibly discards once, and preserves no unsaved entity", async () => {
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();

    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-quit-guard-seed") await seedPhase();
    else if (phase === "chromium-quit-guard-restart") await restartPhase();
    else throw new Error(`Unexpected Chromium quit-guard phase ${phase}`);
  });
});
