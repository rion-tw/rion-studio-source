/** Shared strict release version syntax; callers retain their own error contracts. */
export function isSupportedStrictSemanticVersion(value) {
  if (typeof value !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
  if (!match) return false;
  return !match[4]?.split(".").some((part) =>
    /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0")
  );
}
