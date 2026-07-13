import { existsSync } from "node:fs";
import path from "node:path";

import { signAsync } from "@electron/osx-sign";

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

export async function signMacApp(context, signer = signAsync) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  assertNoBundledPlaywrightBrowsers(context);

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  await signer({
    app: appPath,
    identity: "-",
    identityValidation: false,
    platform: "darwin",
    hardenedRuntime: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    // osx-sign 1.3.1 emits the invalid `codesign --strict=true` form.
    // Release jobs run a separate strict verification after packaging.
    strictVerify: false,
    timestamp: "none"
  });
}

export default signMacApp;
