import { existsSync } from "node:fs";
import path from "node:path";

export function assertNoBundledPlaywrightBrowsers(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  const browserPayloadPath = path.join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "playwright-core",
    ".local-browsers"
  );

  if (existsSync(browserPayloadPath)) {
    throw new Error(`Packaged app must not include Playwright browser payload: ${browserPayloadPath}`);
  }
}

export default assertNoBundledPlaywrightBrowsers;
