export function v1Case<T>(
  id: string,
  assertions: () => T | Promise<T>
): T | Promise<T> {
  if (id.length === 0) {
    throw new Error("v1 parity case identifiers must not be empty");
  }
  return assertions();
}
