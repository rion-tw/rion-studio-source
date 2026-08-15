export function requiresRendererTabChromeProjection(
  platform: NodeJS.Platform
): boolean {
  return platform === "win32";
}

export function requiresPrearmedNativeTabMenuSelection(
  platform: NodeJS.Platform
): boolean {
  return platform === "darwin" || platform === "win32";
}
