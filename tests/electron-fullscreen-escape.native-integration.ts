import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Key, remote } from "webdriverio";
import { sendChromiumEscapeKey } from "../e2e/desktop/support/chromium-escape-key";

const require = createRequire(import.meta.url);

it("exits contained HTML fullscreen through the exact ChromeDriver key helper", async () => {
  expect(["darwin", "win32"]).toContain(process.platform);
  const platform = process.platform === "win32" ? "windows" : "macos";
  const driver = await remote({
    logLevel: "error", connectionRetryCount: 0, connectionRetryTimeout: 20_000,
    capabilities: {
      browserName: "chrome", browserVersion: "150.0.7871.224",
      "wdio:enforceWebDriverClassic": true,
      "goog:chromeOptions": {
        binary: require("electron") as string,
        args: [`--app=${resolve("tests/fixtures/chromium-fullscreen-escape/main.cjs")}`]
      }
    }
  });
  try {
    await driver.waitUntil(async () => {
      for (const handle of await driver.getWindowHandles()) {
        await driver.switchToWindow(handle);
        if (await driver.getTitle() === "Chromium Escape Fixture") return true;
      }
      return false;
    }, { timeout: 10_000 });
    const outcomes: { mode: string; fullscreen: boolean }[] = [];
    for (const mode of ["generic-w3c", "complete-key-codes"]) {
      await (await driver.$("#enter")).click();
      await driver.waitUntil(() => driver.execute(() => !!document.fullscreenElement));
      if (mode === "generic-w3c") {
        await driver.action("key").down(Key.Escape).up(Key.Escape).perform();
      } else {
        await sendChromiumEscapeKey(driver, platform);
        await driver.waitUntil(() => driver.execute(() => !document.fullscreenElement));
      }
      outcomes.push({ mode, fullscreen: await driver.execute(() => !!document.fullscreenElement) });
      // Research-case cleanup only; the complete-key-codes assertion ran before this.
      await driver.execute(() => document.exitFullscreen().catch(() => {}));
    }
    expect(outcomes[1]).toEqual({ mode: "complete-key-codes", fullscreen: false });
    const reportDirectory = process.env.RION_CHROMIUM_INPUT_REPORT_DIR;
    if (reportDirectory) {
      await mkdir(reportDirectory, { recursive: true });
      await writeFile(join(reportDirectory, `fullscreen-escape-${process.platform}.json`),
        JSON.stringify({ platform, electron: require("electron/package.json").version, outcomes }, null, 2));
    }
  } finally {
    await driver.deleteSession();
  }
});
