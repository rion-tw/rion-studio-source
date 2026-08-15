export function requiresRendererTabChromeProjection(
  platform: NodeJS.Platform
): boolean {
  return platform === "win32";
}
