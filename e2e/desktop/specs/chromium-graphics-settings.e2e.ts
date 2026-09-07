import { resolve } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { rendererCall } from "../support/renderer-bridge";
import { acceptLegalAndSkipFirstRun, ensureEnglishUi, waitForRoute } from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-GRAPHICS-SETTINGS-001]
// [journey:CHROMIUM-WINDOWS-GRAPHICS-SETTINGS-001]

describe("Chromium graphics settings", () => {
  it("persists visible selections and reports actual acceleration after a fresh process", async () => {
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const sidebar = await $(".app-main-sidebar");
    await sidebar.$("button*=Settings").click();
    await waitForRoute("/settings");
    await expect($("button[role='switch'][aria-label='GPU hardware acceleration']")).not.toExist();
    const settingsSidebar = await $(".settings-mode-sidebar");
    const graphicsPage = await settingsSidebar.$("button=Graphics settings");
    await graphicsPage.waitForDisplayed({ timeout: 10_000 });
    await graphicsPage.click();
    await waitForRoute("/settings?section=graphics");
    await expect($("h1=Graphics settings")).toBeDisplayed();

    const toggle = await $("button[role='switch'][aria-label='GPU hardware acceleration']");
    await toggle.waitForDisplayed({ timeout: 20_000 });
    const raster = await $("button[role='combobox'][aria-label='GPU Rasterization']");
    const video = await $("button[role='combobox'][aria-label='Hardware video decoding']");
    const phase = process.env.RION_STUDIO_E2E_PHASE;
    if (phase === "chromium-graphics-settings-seed") {
      await raster.scrollIntoView({ block: "center" });
      await raster.click(); await $("[role='option']*=Enabled").click();
      await expect(raster).toHaveText("Enabled");
      await video.click(); await $("[role='option']*=Disabled").click();
      await expect(video).toHaveText("Disabled");
      await toggle.scrollIntoView({ block: "center" }); await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(raster).toBeDisabled(); await expect(video).toBeDisabled();
      await expect($("button=Restart")).toExist();
    } else if (phase === "chromium-graphics-settings-restart") {
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(raster).toHaveText("Enabled");
      await expect(video).toHaveText("Disabled");
      await expect($("button=Restart")).not.toExist();
      await browser.waitUntil(async () => (await rendererCall("getGraphicsStatus")).initialized,
        { timeout: 20_000, timeoutMsg: "No authoritative GPU information event after restart" });
      const status = await rendererCall("getGraphicsStatus");
      expect(status.hardwareAcceleration).toBe(false);
      expect(status.appliedSettings?.hardwareAcceleration).toBe(false);
    } else throw new Error(`Unexpected graphics phase ${phase}`);
    const info = await $("section[aria-label='Graphics information']");
    await expect(info.$("details")).not.toExist();
    await info.$("h3=Graphics feature status").scrollIntoView({ block: "center" });
    await expect($("h3=Graphics feature status")).toBeDisplayed();
    await $("button=Refresh").click();
    await $("button=Copy report").click();
    await expect($("button=Copied")).toBeDisplayed();
    const artifactDirectory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
    if (!artifactDirectory) throw new Error("Graphics journey requires an artifact directory");
    await browser.saveScreenshot(resolve(artifactDirectory, "graphics-settings.png"));
    await $("h3=Graphics feature status").scrollIntoView({ block: "start" });
    await browser.executeAsync((done: () => void) => {
      requestAnimationFrame(() => requestAnimationFrame(() => done()));
    });
    await browser.saveScreenshot(resolve(artifactDirectory, "graphics-information.png"));
    const saved = await rendererCall("getGraphicsSettings");
    expect(saved.settings).toEqual({ hardwareAcceleration: false, rasterization: "enabled", videoDecode: "disabled" });
    // The shared desktop harness closes cleanly and relaunches the same SQLite
    // namespace between phases. No renderer reload substitutes for process restart.
  });
});
