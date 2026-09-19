import type { ElectronDesktopPlatform } from "./windowOptions";

/** Windows 11 22H2; DWM exposes no Mica system backdrop before this build. */
const MICA_MINIMUM_BUILD = 22621;

/**
 * Reads the Mica capability from an `os.release()` string such as `10.0.26200`.
 * Anything unparsable is treated as unsupported so the host stays opaque rather
 * than requesting a material Windows will silently drop.
 */
export function windowsMicaSupported(
  platform: ElectronDesktopPlatform,
  release: string
): boolean {
  if (platform !== "win32") return false;
  const [major, , build] = release.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(build)) return false;
  return major >= 10 && build >= MICA_MINIMUM_BUILD;
}
