import { $, browser, expect } from "@wdio/globals";
import type { ResolvedTheme } from "../../../src/shared/types";
import { withWorkspaceWebChromeTarget } from "./electron-role-surface";
import { waitForRoute } from "./ui";

interface ThemeTarget {
  readonly chromeShellUrl: string;
  readonly contentUrl: string;
  readonly mainWindowHandle: string;
}

export async function expectWorkspaceWebTheme(target: ThemeTarget, theme: ResolvedTheme): Promise<void> {
  await withWorkspaceWebChromeTarget(
    target.chromeShellUrl, target.contentUrl, target.mainWindowHandle, async () => {
      await browser.waitUntil(async () => browser.execute(expected =>
        document.documentElement.dataset.theme === expected &&
        getComputedStyle(document.documentElement).colorScheme === expected,
      theme), { timeout: 10_000, timeoutMsg: `Web chrome did not apply ${theme}` });
      const colors = await browser.execute(() => {
        const body = getComputedStyle(document.body);
        const location = getComputedStyle(document.querySelector("#location")!);
        const field = getComputedStyle(document.querySelector("#location-form")!);
        return { background: body.backgroundColor, foreground: body.color,
          inputBackground: field.backgroundColor, inputForeground: location.color };
      });
      const brightness = (color: string) => {
        const channels = color.match(/[\d.]+/gu)!.slice(0, 3).map(Number);
        return channels.reduce((sum, channel) => sum + channel, 0) / 3;
      };
      expect(colors.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(brightness(colors.background) >= 128).toBe(theme === "light");
      expect(Math.abs(brightness(colors.background) - brightness(colors.foreground)))
        .toBeGreaterThan(100);
      expect(colors.inputForeground).toBe(colors.foreground);
      expect(colors.inputBackground).not.toBe("rgba(0, 0, 0, 0)");
    }
  );
}

export async function exerciseWorkspaceWebThemes(target: ThemeTarget): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.$("button*=Settings").click();
  await waitForRoute("/settings");
  const preferences = await $(".settings-mode-sidebar").$("button=Preferences");
  await preferences.waitForClickable({ timeout: 10_000 });
  await preferences.click();
  for (const theme of ["dark", "light", "dark"] as const) {
    const button = await $(`button=${theme === "light" ? "Light" : "Dark"}`);
    await button.waitForClickable({ timeout: 10_000 });
    await button.click();
    await browser.waitUntil(async () =>
      await button.getAttribute("aria-pressed") === "true" &&
      await browser.execute(() => document.documentElement.dataset.theme) === theme,
    { timeout: 10_000, timeoutMsg: `Settings did not apply ${theme}` });
    await expectWorkspaceWebTheme(target, theme);
  }
  let triggerLabel = "Language";
  for (const [language, option, nextTrigger, home] of [
    ["zh-TW", "繁體中文", "語言", "首頁"],
    ["zh-CN", "简体中文", "语言", "首页"],
    ["ja", "日本語", "言語", "ホーム"],
    ["en", "English", "Language", "Home"]
  ]) {
    await $(`button[aria-label='${triggerLabel}']`).click();
    const item = await $(`[role='option']=${option}`);
    await item.waitForClickable({ timeout: 10_000 });
    await item.click();
    await $(`button[aria-label='${nextTrigger}']`).waitForDisplayed({ timeout: 10_000 });
    await withWorkspaceWebChromeTarget(target.chromeShellUrl, target.contentUrl, target.mainWindowHandle, async () => {
      await expect($("html")).toHaveAttribute("lang", language);
      await expect($("#home")).toHaveAttribute("aria-label", home);
      await expect($("#address-state")).toHaveAttribute("title", home);
    });
    triggerLabel = nextTrigger;
  }
  await $("button=Back to app").click();
  await $(".app-main-sidebar").waitForDisplayed({ timeout: 10_000 });
}
