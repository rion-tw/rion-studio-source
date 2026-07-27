export function parseLocalStorageSyncKeys(value: string): string[] {
  const seen = new Set<string>();
  return value.split(/\r?\n/).map((key) => key.trim()).filter((key) => {
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
