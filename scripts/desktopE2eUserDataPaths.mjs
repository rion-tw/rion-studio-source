import { createHash } from "node:crypto";
import { resolve } from "node:path";

function compactName(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export function resolveDesktopE2eUserDataLayout({
  artifactBase,
  artifactRoot,
  configuredRoot,
  platform,
  runId
}) {
  const compactWindowsLayout = platform === "win32" && !configuredRoot;
  return Object.freeze({
    compactWindowsLayout,
    userDataRoot: resolve(
      configuredRoot ?? (
        compactWindowsLayout
          ? resolve(artifactBase, `.u-${compactName(runId)}`)
          : resolve(artifactRoot, "user-data")
      )
    )
  });
}

export function desktopE2eUserDataDir(layout, namespace) {
  return resolve(
    layout.userDataRoot,
    layout.compactWindowsLayout ? compactName(namespace) : namespace
  );
}
