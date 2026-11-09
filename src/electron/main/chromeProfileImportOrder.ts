/**
 * Canonical Chrome Profile import order. Rust orders cookie and LocalStorage
 * identities with `str::cmp` (UTF-8 bytes), and the helper must rebuild the
 * byte-identical payload; locale collation (`localeCompare`) puts `_ga` before
 * `PHPSESSID` and fails the exact comparison for ordinary sites.
 */
export function compareUtf8(left: string, right: string): number {
  return left === right ? 0 : Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
