import { $, browser, expect } from "@wdio/globals";

import { readElectronRoleFontState } from "../support/electron-role-surface";
import { electronDesktopE2eFocusMainWindow } from "../support/electron-driver";
import { rendererCall } from "../support/renderer-bridge";
import {
  bootstrapChromiumMacroCutover, createChromiumMacroWindow,
  launchChromiumRoleVisible, macroFixtureUrl
} from "./chromium-macro-cutover-support";

export async function prepareChromiumFontRole() {
  const context = await bootstrapChromiumMacroCutover();
  const fixtureId = "chromium-font-application";
  const url = macroFixtureUrl(fixtureId, "mode=observe");
  const game = await rendererCall("createGame", { name: "Font Application Game", defaultLaunchUrl: url });
  const role = await rendererCall("createRole", { gameId: game.id, name: "Font Application Role", launchUrl: url });
  const window = await createChromiumMacroWindow("c8e00000-0000-4000-8000-000000000033", "Font Application Window");
  await launchChromiumRoleVisible(role, fixtureId, window);
  await electronDesktopE2eFocusMainWindow();
  return { ...context, url };
}

export async function verifyChromiumFontApplication(input: Awaited<ReturnType<typeof prepareChromiumFontRole>>) {
  const read = async () => {
    const state = await readElectronRoleFontState(input.url, input.mainWindowHandle);
    expect(state.trusted).toBe(true);
    expect(state.canvasHookInstalled).toBe(true);
    await electronDesktopE2eFocusMainWindow();
    return state;
  };
  const before = await read();
  expect(before.wideGlyphWidth).not.toBe(before.narrowGlyphWidth);
  const pick = async (family: string, slot = "English & Latin") => {
    const picker = await $(`button[aria-label='${slot}']`);
    await picker.scrollIntoView({ block: "center" });
    await picker.click();
    const option = await $(`[role='menuitemradio']*=${family} · System`);
    await option.waitForDisplayed({ timeout: 10_000 });
    await option.click();
  };
  const press = async (label: string) => {
    const button = await $(`button=${label}`);
    await button.scrollIntoView({ block: "center" });
    await button.waitForClickable({ timeout: 10_000 });
    await button.click();
  };
  await browser.waitUntil(async () => {
    const loading = await $("div[role='status']*=Loading installed fonts.");
    return !(await loading.isDisplayed());
  }, { timeout: 60_000, interval: 100, timeoutMsg: "System font enumeration did not finish" });
  const inventory = await rendererCall("listSystemFonts");
  const nativeFamily = input.platform === "macos" ? "Hiragino Sans" : "Segoe UI";
  expect(inventory.some((font) => font.family === nativeFamily)).toBe(true);
  expect(inventory.every((font) => !/\.(?:ttc|ttf|otf|dfont)$/iu.test(font.family))).toBe(true);
  expect(inventory.some((font) => font.family === "Courier New")).toBe(true);
  await pick("Courier New");
  await press("Cancel changes");
  expect(await read()).toEqual(before);
  await pick("ui-monospace");
  await press("Cancel changes");
  expect(await read()).toEqual(before);
  await pick("ui-monospace");
  await pick("ui-monospace", "Numbers");
  await press("Apply");
  await browser.waitUntil(async () => {
    const state = await read();
    return state.bodyFamily.startsWith("ui-monospace") &&
      state.canvasFont === "16px sans-serif" &&
      state.wideGlyphWidth === state.narrowGlyphWidth;
  }, { timeout: 15_000, interval: 100, timeoutMsg: "Font override did not reach live Role CSS and Canvas" });
  const applied = await rendererCall("getGameBrowserSettings");
  expect(applied.fonts.slots.latin).toEqual({ source: "system", family: "ui-monospace" });
  expect((await read()).style).toContain("ui-monospace");
  await pick("Courier New");
  await pick("Courier New", "Numbers");
  await press("Apply");
  await browser.waitUntil(async () => {
    const state = await read();
    return state.bodyFamily.includes("Rion Studio latin system") &&
      ["latin", "numeric"].every((slot) =>
        state.loadedFamilies.some((family) => family.includes(`Rion Studio ${slot} system`))
      ) && state.wideGlyphWidth === state.narrowGlyphWidth;
  }, { timeout: 15_000, interval: 100, timeoutMsg: "Named font did not load in the live Role" });
  expect((await rendererCall("getGameBrowserSettings")).fonts.slots.latin).toEqual({
    source: "system", family: "Courier New"
  });
  await press("Reset to system fonts");
  await press("Apply");
  await browser.waitUntil(async () => JSON.stringify(await read()) === JSON.stringify(before), {
    timeout: 15_000, interval: 100, timeoutMsg: "Reset did not restore live Role CSS and Canvas"
  });
}
