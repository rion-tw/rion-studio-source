import path from "node:path";

import { signAsync } from "@electron/osx-sign";

export async function signMacApp(context, signer = signAsync) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

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
