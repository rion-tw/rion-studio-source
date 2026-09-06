import { posix, win32 } from "node:path";

type SupportedPlatform = "darwin" | "win32";

export function chromiumPathApi(platform: SupportedPlatform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** Pure wire-path validation; physical ownership and symlink policy belong to Rust. */
export function canonicalChromiumPath(
  value: unknown,
  platform: SupportedPlatform
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return null;
  }
  // Chromium must receive an ordinary absolute drive/UNC path, never an NT
  // device path. Echoing storagePath does not prove device-path durability.
  if (platform === "win32" &&
    (value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\"))) return null;
  if (platform === "win32" &&
    !/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/iu.test(value)) return null;
  const paths = chromiumPathApi(platform);
  return paths.isAbsolute(value) && paths.normalize(value) === value
    ? value
    : null;
}

/** Preserve the existing conservative Windows alias fence across all registries. */
export function chromiumPathKey(path: string, platform: SupportedPlatform): string {
  return platform === "win32" ? path.toLowerCase() : path;
}

export function chromiumPathSegmentEquals(
  actual: string,
  expected: string,
  platform: SupportedPlatform
): boolean {
  return chromiumPathKey(actual, platform) === chromiumPathKey(expected, platform);
}
