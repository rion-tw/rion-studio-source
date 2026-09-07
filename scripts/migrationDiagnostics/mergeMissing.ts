export interface StorageEntry { key: string; value: string }
export function mergeMissing(current: readonly StorageEntry[], retained: readonly StorageEntry[]): StorageEntry[] {
  const values = new Map<string, string>();
  for (const entry of current) {
    if (values.has(entry.key)) throw new Error("DUPLICATE_CURRENT_KEY");
    values.set(entry.key, entry.value);
  }
  const seen = new Set<string>();
  for (const entry of retained) {
    if (seen.has(entry.key)) throw new Error("DUPLICATE_RETAINED_KEY");
    seen.add(entry.key);
    if (!values.has(entry.key)) values.set(entry.key, entry.value);
  }
  return [...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => ({ key, value }));
}
