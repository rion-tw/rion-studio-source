import { $, browser, expect } from "@wdio/globals";

import { readElectronRoleFontState } from "../support/electron-role-surface";
import { electronDesktopE2eFocusMainWindow } from "../support/electron-driver";
import { rendererCall } from "../support/renderer-bridge";
import { scrollLayoutControlIntoView } from "../support/ui";
import {
  bootstrapChromiumMacroCutover, createChromiumMacroWindow,
  launchChromiumRoleVisible, macroFixtureUrl, writeChromiumMacroEvidence
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
  const pickerEvidence: unknown[] = [];
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
    await scrollLayoutControlIntoView(picker);
    await picker.waitForClickable({ timeout: 10_000 });
    const beforeClick = await browser.execute((target: HTMLElement) => {
      const bounds = target.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      document.documentElement.removeAttribute("data-rion-font-click");
      document.addEventListener("click", (event) => {
        document.documentElement.setAttribute("data-rion-font-click", JSON.stringify({
          expectedTarget: event.composedPath().includes(target), trusted: event.isTrusted,
          targetTag: (event.target as HTMLElement | null)?.tagName,
          targetLabel: (event.target as HTMLElement | null)?.getAttribute("aria-label"),
          metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey
        }));
      }, { capture: true, once: true });
      return { hitMatches: hit !== null && target.contains(hit), hasFocus: document.hasFocus(),
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
    }, picker as unknown as HTMLElement);
    await picker.click();
    const option = await $(`[role='menuitemradio']*=${family} · System`);
    try {
      await option.waitForDisplayed({ timeout: 10_000 });
    } finally {
      const afterClick = await browser.execute((target: HTMLElement) => ({
        expanded: target.getAttribute("aria-expanded"),
        receipt: document.documentElement.getAttribute("data-rion-font-click"),
        menuCount: document.querySelectorAll("[role='menu']").length
      }), picker as unknown as HTMLElement);
      pickerEvidence.push({ family, slot, beforeClick, afterClick });
      await writeChromiumMacroEvidence("chromium-font-picker-click.json", pickerEvidence);
    }
    await option.click();
  };
  const press = async (label: string) => {
    const button = await $(`button=${label}`);
    await scrollLayoutControlIntoView(button);
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
