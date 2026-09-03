import { posix, win32 } from "node:path";

import { resolveVerifiedWindowsProfileIsolation } from
  "./windowsIsolatedProfile.mjs";

const PRODUCT_NAME = "Rion Studio";

export function resolvePackagedElectronSmokeIsolation(
  artifactDirectory,
  platform,
  environment = process.env
) {
  const paths = platform === "win32" ? win32 : posix;
  if (
    platform !== "darwin" && platform !== "win32" ||
    typeof artifactDirectory !== "string" ||
    !paths.isAbsolute(artifactDirectory) ||
    paths.normalize(artifactDirectory) !== artifactDirectory
  ) {
    throw new Error("Packaged Electron smoke requires a canonical platform-absolute artifact path.");
  }

  const runtimeHomeDirectory = paths.join(artifactDirectory, "runtime-home");
  if (platform === "darwin") {
    return Object.freeze({
      environment: Object.freeze({ CFFIXED_USER_HOME: runtimeHomeDirectory }),
      isolationKind: "fixed-macos-home",
      runtimeHomeDirectory,
      userDataDirectory: paths.join(
        runtimeHomeDirectory,
        "Library",
        "Application Support",
        PRODUCT_NAME
      )
    });
  }

  const profile = resolveVerifiedWindowsProfileIsolation(environment);
  return Object.freeze({
    environment: Object.freeze({}),
    isolationKind: profile.kind,
    runtimeHomeDirectory: profile.profileDirectory,
    userDataDirectory: profile.userDataDirectory
  });
}
