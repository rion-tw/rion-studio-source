import { RionBridgeError } from "../ipc/errors";

function invalidRoleUrl(): never {
  throw new RionBridgeError({
    code: "ELECTRON_ROLE_SURFACE_URL_INVALID",
    message: "A canonical HTTP(S) URL is required for the Chromium role surface."
  });
}

export function canonicalChromiumRoleUrl(value: unknown): string {
  const containsUnsafeCharacter = typeof value === "string" && [...value].some(
    (character) => {
      const codePoint = character.codePointAt(0)!;
      return character === "\\" || /\s/u.test(character) ||
        codePoint <= 0x1f || codePoint === 0x7f;
    }
  );
  if (
    typeof value !== "string" || value.length === 0 ||
    value !== value.trim() || containsUnsafeCharacter ||
    !/^https?:\/\//iu.test(value)
  ) {
    invalidRoleUrl();
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalidRoleUrl();
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0 || parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    invalidRoleUrl();
  }
  return parsed.href;
}

export function isAllowedChromiumRoleNavigation(url: string): boolean {
  try {
    canonicalChromiumRoleUrl(url);
    return true;
  } catch {
    return false;
  }
}
